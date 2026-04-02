/**
 * CloudHand 中继服务器 (v2 - Token 直连认证)
 * 由 OpenClaw AI 智能体启动，桥接本地终端和远程 Web UI
 *
 * 用法: node relay-server.js --port <PORT>
 * 本地机器带着自己的 Token 主动连接，中继自动注册并记住
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn } = require('child_process');

// ==================== 命令行参数解析 ====================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { port: 3456 };

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--port=')) {
      config.port = parseInt(args[i].split('=')[1]);
    } else if (args[i] === '--port' && args[i + 1]) {
      config.port = parseInt(args[i + 1]);
      i++;
    } else if (args[i].startsWith('--pair-code')) {
      // 兼容旧参数，打印警告后忽略
      console.warn('[中继] ⚠️  --pair-code 参数已废弃，已忽略。新版使用 Token 直连认证。');
      if (args[i] === '--pair-code' && args[i + 1]) i++;
    }
  }

  return config;
}

const config = parseArgs();

// ==================== 客户端注册表（持久化） ====================

const CLIENTS_FILE = path.join(__dirname, 'clients.json');
const CLIENT_TTL = 60 * 60 * 1000;       // 1小时未连接则清理
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 每10分钟清理一次

// 内存中的注册表: token -> { token, computer_name, firstSeen, lastSeen }
let clientRegistry = new Map();

// 当前活跃的终端 WS 连接: token -> WebSocket
const terminalClients = new Map();

// 浏览器 UI 连接: Set<{ws, token}>
const uiClients = new Set();

// ---- 注册表的加载/保存 ----

function loadClients() {
  try {
    if (fs.existsSync(CLIENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
      clientRegistry = new Map(data.map(c => [c.token, c]));
      console.log(`[中继] 📂 已加载 ${clientRegistry.size} 条客户端记录`);
    }
  } catch (err) {
    console.warn('[中继] ⚠️  clients.json 读取失败，以空注册表启动:', err.message);
    clientRegistry = new Map();
  }
}

function saveClients() {
  try {
    const data = Array.from(clientRegistry.values());
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[中继] ❌ clients.json 保存失败:', err.message);
  }
}

// 注册或更新客户端（首来即信任）
function upsertClient(token, computerName) {
  const now = Date.now();
  const existing = clientRegistry.get(token);

  if (existing) {
    existing.computer_name = computerName || existing.computer_name;
    existing.lastSeen = now;
  } else {
    clientRegistry.set(token, {
      token,
      computer_name: computerName || '未命名',
      firstSeen: now,
      lastSeen: now
    });
  }
  saveClients();
}

// 检查 token 是否已注册（或允许新注册）
function isTokenKnown(token) {
  return token && typeof token === 'string' && token.length > 8;
}

// 定时清理过期记录
function cleanupClients() {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, info] of clientRegistry) {
    // 超过1小时未连接 且 当前不在线
    if (now - info.lastSeen > CLIENT_TTL && !terminalClients.has(token)) {
      clientRegistry.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    saveClients();
    console.log(`[中继] 🧹 清理了 ${cleaned} 条过期客户端记录`);
  }
}

// 加载已有数据
loadClients();

// 启动定时清理
setInterval(cleanupClients, CLEANUP_INTERVAL);

// ==================== HTTP 服务器 ====================

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 首页 — 处理 URL token 参数 或 cookie token
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?'))) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const queryToken = urlObj.searchParams.get('token');
    const cookies = parseCookies(req);

    // URL 带 token：验证后设置 cookie 并直接返回 UI
    if (queryToken) {
      if (clientRegistry.has(queryToken)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `token=${queryToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        });
        res.end(loadHtmlFile('ui.html'));
      } else {
        // token 未注册（该机器从未连接过），显示提示页
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loadHtmlFile('login.html'));
      }
      return;
    }

    // Cookie 中有已注册的 token → 显示终端 UI
    if (cookies.token && clientRegistry.has(cookies.token)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loadHtmlFile('ui.html'));
      return;
    }

    // 无有效 token → 显示提示页
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loadHtmlFile('login.html'));
    return;
  }

  // API: 在线机器列表（供 OpenClaw 查询，不暴露 token）
  if (req.method === 'GET' && req.url === '/api/clients') {
    if (!isLocalRequest(req)) {
      return jsonResponse(res, 403, { error: 'Forbidden', message: 'Local access only' });
    }
    const list = Array.from(clientRegistry.values()).map(c => ({
      computer_name: c.computer_name,
      connected: terminalClients.has(c.token),
      lastSeen: c.lastSeen
    }));
    jsonResponse(res, 200, list);
    return;
  }

  // API: 连接状态
  if (req.method === 'GET' && req.url === '/api/status') {
    if (!isLocalRequest(req)) {
      return jsonResponse(res, 403, { error: 'Forbidden', message: 'Local access only' });
    }
    jsonResponse(res, 200, {
      terminalCount: terminalClients.size,
      uiClients: uiClients.size,
      registeredClients: clientRegistry.size
    });
    return;
  }

  // ==================== Agent API 路由 ====================

  // 所有 /agent/* 路由仅限本地访问
  if (req.url.startsWith('/agent/')) {
    if (!isLocalRequest(req)) {
      return jsonResponse(res, 403, { error: 'Forbidden', message: 'Local access only' });
    }

    // POST /agent/start — 初始化 Agent 会话
    if (req.method === 'POST' && req.url === '/agent/start') {
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body);
          if (agent.state !== 'offline') {
            return jsonResponse(res, 400, { ok: false, error: 'Agent 已在运行，请先 stop' });
          }
          agent.cwd = data.cwd || process.cwd();
          agent.allowedTools = data.allowedTools || ['Read', 'Edit', 'Bash', 'Write'];
          agent.state = 'idle';
          agent.sessionId = null;
          agent.history = [];
          agent.totalTurns = 0;
          agent.currentProcess = null;
          console.log(`[Agent] ✅ 已初始化，工作目录: ${agent.cwd}`);
          jsonResponse(res, 200, { ok: true, state: 'idle' });
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: '请求体 JSON 解析失败' });
        }
      });
      return;
    }

    // POST /agent/send — 发送消息并等待 Claude 回复
    if (req.method === 'POST' && req.url === '/agent/send') {
      readBody(req, async (body) => {
        try {
          const data = JSON.parse(body);
          const message = data.message;
          if (!message) {
            return jsonResponse(res, 400, { ok: false, error: '缺少 message 字段' });
          }
          if (agent.state === 'offline') {
            return jsonResponse(res, 400, { ok: false, error: 'Agent 未启动，请先 start' });
          }
          if (agent.state === 'busy') {
            return jsonResponse(res, 429, { ok: false, error: 'Agent 正忙，请等待上一轮完成' });
          }

          // 记录 OpenClaw 发送的消息
          agent.history.push({ role: 'openclaw', message, timestamp: Date.now() });
          agent.state = 'busy';
          emitToStreamClients({ type: 'status', state: 'busy' }); // 通知所有 SSE 客户端进入 busy

          try {
            const result = await agentQueryClaude(message);
            agent.state = 'idle';
            agent.totalTurns++;
            emitToStreamClients({ type: 'status', state: 'idle' }); // 通知所有 SSE 客户端回到 idle

            // 记录 Claude 的回复
            agent.history.push({
              role: 'claude',
              message: result.reply,
              exitCode: result.exitCode,
              timestamp: Date.now()
            });

            jsonResponse(res, 200, {
              ok: result.exitCode === 0,
              reply: result.reply,
              sessionId: agent.sessionId,
              exitCode: result.exitCode,
              state: 'idle'
            });
          } catch (err) {
            agent.state = 'idle';
            emitToStreamClients({ type: 'status', state: 'idle', error: err.message });
            agent.history.push({
              role: 'claude',
              message: '[ERROR] ' + err.message,
              exitCode: -1,
              timestamp: Date.now()
            });
            jsonResponse(res, 500, {
              ok: false,
              error: err.message,
              exitCode: -1,
              state: 'idle'
            });
          }
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: '请求体 JSON 解析失败' });
        }
      });
      return;
    }

    // GET /agent/status — 查询状态
    if (req.method === 'GET' && req.url === '/agent/status') {
      jsonResponse(res, 200, {
        state: agent.state,
        sessionId: agent.sessionId,
        cwd: agent.cwd,
        totalTurns: agent.totalTurns
      });
      return;
    }

    // GET /agent/stream — SSE 实时事件流（只读，不触发任何操作）
    if (req.method === 'GET' && req.url === '/agent/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // 禁止 Nginx 缓冲，确保实时推送
      });
      // 立即推送当前状态快照
      res.write(`data: ${JSON.stringify({ type: 'status', state: agent.state, sessionId: agent.sessionId })}\n\n`);
      // 注册为订阅者
      agent.streamClients.add(res);
      req.on('close', () => {
        agent.streamClients.delete(res);
      });
      return;
    }

    // GET /agent/history — 获取对话历史
    if (req.method === 'GET' && (req.url === '/agent/history' || req.url.startsWith('/agent/history?'))) {
      jsonResponse(res, 200, {
        ok: true,
        history: agent.history,
        state: agent.state,
        sessionId: agent.sessionId
      });
      return;
    }

    // POST /agent/stop — 关闭会话
    if (req.method === 'POST' && req.url === '/agent/stop') {
      // 杀掉正在运行的子进程
      if (agent.currentProcess) {
        try { agent.currentProcess.kill('SIGTERM'); } catch (e) {}
        agent.currentProcess = null;
      }
      agent.state = 'offline';
      agent.sessionId = null;
      console.log('[Agent] 🛑 会话已关闭');
      jsonResponse(res, 200, { ok: true, state: 'offline' });
      return;
    }

    // 未匹配的 /agent/ 路由
    jsonResponse(res, 404, { error: 'Agent API not found' });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function loadHtmlFile(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), 'utf8');
  } catch (err) {
    return '<h1>Error loading page</h1>';
  }
}

// ==================== WebSocket 服务器 ====================

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => handleTerminalConnection(ws));
  } else if (pathname === '/ws/ui') {
    // 从 query 或 cookie 获取 token
    let token = urlObj.searchParams.get('token');
    if (!token) {
      const cookieStr = request.headers.cookie || '';
      const match = cookieStr.match(/token=([^;]+)/);
      if (match) token = match[1];
    }
    // token 必须是已注册的客户端
    if (!token || !clientRegistry.has(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleUIConnection(ws, request, token));
  } else {
    socket.destroy();
  }
});

// ---- 本地终端连接处理 ----

function handleTerminalConnection(ws) {
  let authenticated = false;
  let clientToken = null;

  // 10 秒认证超时
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: '认证超时' }));
      ws.close();
    }
  }, 10000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // 未认证时只接受 auth 消息
    if (!authenticated) {
      if (msg.type === 'auth') {
        const token = msg.token;
        const computerName = msg.computer_name;

        // 验证 token 格式有效性（UUID 级别长度）
        if (!isTokenKnown(token)) {
          ws.send(JSON.stringify({ type: 'auth_fail', reason: '无效 token' }));
          ws.close();
          return;
        }

        // 如果该 token 已有活跃连接，踢掉旧连接
        if (terminalClients.has(token)) {
          const oldWs = terminalClients.get(token);
          try { oldWs.close(); } catch {}
        }

        clearTimeout(authTimeout);
        authenticated = true;
        clientToken = token;

        // 注册/更新到持久化注册表
        upsertClient(token, computerName);

        // 存入活跃连接 Map
        terminalClients.set(token, ws);

        const info = clientRegistry.get(token);
        ws.send(JSON.stringify({ type: 'auth_ok', computer_name: info.computer_name }));

        // 通知此 token 下的所有 UI 客户端
        broadcastToUIByToken(token, { type: 'terminal_connected', computer_name: info.computer_name });

        console.log(`[中继] ✅ 终端已连接: "${info.computer_name}" (当前共 ${terminalClients.size} 台)`);
      }
      return;
    }

    // 认证后：终端消息转发给对应 token 的 UI 客户端
    if (['output', 'session_created', 'session_closed', 'session_exit', 'session_list'].includes(msg.type)) {
      broadcastToUIByToken(clientToken, msg);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (clientToken && terminalClients.get(clientToken) === ws) {
      terminalClients.delete(clientToken);
      broadcastToUIByToken(clientToken, { type: 'terminal_disconnected' });
      const info = clientRegistry.get(clientToken);
      const name = info ? info.computer_name : clientToken;
      console.log(`[中继] ❌ 终端已断开: "${name}" (当前共 ${terminalClients.size} 台)`);
    }
  });

  ws.on('error', (err) => {
    console.error('[中继] 终端连接错误:', err.message);
  });
}

// ---- 浏览器 UI 连接处理 ----

function handleUIConnection(ws, req, token) {
  const client = { ws, token };
  uiClients.add(client);

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const info = clientRegistry.get(token);
  const computerName = info ? info.computer_name : '未知';
  console.log(`[EVENT] UI_CLIENT_CONNECTED IP: ${clientIp}, 目标机器: "${computerName}"`);
  console.log(`[EVENT] 当前总共 ${uiClients.size} 个 UI 连接`);

  // 发送当前状态
  const termWs = terminalClients.get(token);
  ws.send(JSON.stringify({
    type: 'init',
    terminalConnected: !!(termWs && termWs.readyState === WebSocket.OPEN),
    computer_name: computerName
  }));

  // 如果终端已连接，请求会话列表
  if (termWs && termWs.readyState === WebSocket.OPEN) {
    termWs.send(JSON.stringify({ type: 'list_sessions' }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      // 终端操作：转发给对应 token 的终端
      case 'input':
      case 'create_session':
      case 'close_session':
      case 'resize':
      case 'list_sessions': {
        const tw = terminalClients.get(token);
        if (tw && tw.readyState === WebSocket.OPEN) {
          tw.send(JSON.stringify(msg));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    uiClients.delete(client);
  });
}

// ==================== 工具函数 ====================

// 向指定 token 的所有 UI 客户端广播
function broadcastToUIByToken(token, data) {
  const payload = JSON.stringify(data);
  for (const client of uiClients) {
    if (client.token === token && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function parseCookies(req) {
  const list = {};
  const hdr = req.headers.cookie;
  if (!hdr) return list;
  hdr.split(';').forEach(cookie => {
    let parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => cb(body));
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 检查请求是否来自本地（严格模式）
 * 只信任 socket 层的真实地址，忽略任何代理头（防止伪造）
 */
function isLocalRequest(req) {
  const remoteAddr = req.socket.remoteAddress;
  // 严格只接受本机环回地址，不信任任何代理头
  const localAddrs = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  return localAddrs.includes(remoteAddr);
}

// ==================== Agent 模块 ====================

// Agent 状态（内存中维护，重启丢失）
const agent = {
  state: 'offline',      // offline | idle | busy
  sessionId: null,       // Claude 会话 ID（用于 --resume 多轮上下文）
  cwd: null,             // 工作目录
  allowedTools: [],      // 允许的工具列表
  history: [],           // 对话历史 [{ role, message, timestamp, exitCode? }]
  totalTurns: 0,         // 总对话轮数
  currentProcess: null,  // 当前正在运行的子进程引用
  streamClients: new Set() // SSE 流订阅客户端
};

// 向所有 SSE 流客户端推送事件
function emitToStreamClients(event) {
  if (agent.streamClients.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of agent.streamClients) {
    try { res.write(payload); } catch (e) {}
  }
}

/**
 * 调用 claude -p 执行一轮对话
 * @param {string} prompt - 用户提示
 * @returns {Promise<{reply: string, exitCode: number}>}
 */
function agentQueryClaude(prompt) {
  return new Promise((resolve, reject) => {
    // 构建命令参数
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    // 多轮对话：用 --resume 恢复之前的会话上下文
    if (agent.sessionId) {
      args.push('--resume', agent.sessionId);
    }

    // 工具权限
    if (agent.allowedTools && agent.allowedTools.length > 0) {
      args.push('--allowedTools', agent.allowedTools.join(','));
    }

    console.log(`[Agent] 🚀 执行: claude ${args.join(' ').substring(0, 100)}...`);

    const proc = spawn('claude', args, {
      cwd: agent.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true // Windows 下必须开启 shell: true 才能正确调用 npm/pnpm 安装的 .cmd/.ps1 脚本
    });

    agent.currentProcess = proc;
    // 立即关闭 stdin：-p 模式是非交互的，不需要 stdin
    // 不关闭会导致 Claude CLI 误判为"用户按了 Ctrl+C"，输出 "Request interrupted by user"
    proc.stdin.end();

    let stdoutBuffer = ''; // 用于累计数据块，处理可能的截断
    let fullRawStdout = ''; // 完整原始输出日志
    let stderr = '';
    let extractedText = '';
    let extractedSessionId = null;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullRawStdout += text;
      stdoutBuffer += text;

      // 循环处理，直到缓冲区中没有完整的换行符
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        if (!line) continue;

        try {
          const event = JSON.parse(line);

          // 提取 session_id（首次出现时保存）
          if (event.session_id && !extractedSessionId) {
            extractedSessionId = event.session_id;
          }

          // 提取助手文本内容 (stream-json 格式)
          if (event.type === 'assistant' && event.message?.content) {
            const parts = Array.isArray(event.message.content)
              ? event.message.content
              : [event.message.content];
            for (const part of parts) {
              if (typeof part === 'string') {
                extractedText += part;
                emitToStreamClients({ type: 'text', text: part }); // 实时推送文本片段
              } else if (part.type === 'text' && part.text) {
                extractedText += part.text;
                emitToStreamClients({ type: 'text', text: part.text }); // 实时推送文本片段
              } else if (part.type === 'tool_use') {
                emitToStreamClients({ type: 'tool_use', tool: part.name, input: part.input }); // 推送工具调用
              }
            }
          }

          // result 类型包含最终文本 (作为兜底)
          if (event.type === 'result' && event.result) {
            if (!extractedText) extractedText = event.result;
            if (event.session_id) extractedSessionId = event.session_id;
            emitToStreamClients({ type: 'result', text: event.result, exitCode: 0 });
          }
        } catch (e) {
          // 非 JSON 行或残缺 JSON，忽略
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      agent.currentProcess = null;

      // 更新 sessionId（用于后续多轮对话）
      if (extractedSessionId) {
        agent.sessionId = extractedSessionId;
      }

      // 提取回复：优先使用结构化解析的文本，若没有则用 stdout/stderr
      const reply = extractedText || fullRawStdout || stderr || '(无输出)';
      console.log(`[Agent] ✅ Claude 退出，code=${code}，回复长度=${reply.length}，sessionId=${agent.sessionId || 'N/A'}`);

      resolve({ reply: reply.trim(), exitCode: code || 0 });
    });

    proc.on('error', (err) => {
      agent.currentProcess = null;
      console.error(`[Agent] ❌ 进程错误: ${err.message}`);
      reject(new Error('Claude CLI 启动失败: ' + err.message));
    });
  });
}

// ==================== 启动 ====================

server.listen(config.port, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║       ☁️  CloudHand Relay Server  v0.1.0       ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  Web UI:    http://localhost:${config.port}`);
  console.log(`║  WS 终端:   ws://localhost:${config.port}/ws/terminal`);
  console.log(`║  WS UI:     ws://localhost:${config.port}/ws/ui`);
  console.log(`║  机器API:   http://localhost:${config.port}/api/clients`);
  console.log(`║  已注册:    ${clientRegistry.size} 台机器`);
  console.log('║  认证模式:  🔑 Token 直连 (首来即信任)');
  console.log('║  状态:      ⏳ 等待本地终端连接...');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});
