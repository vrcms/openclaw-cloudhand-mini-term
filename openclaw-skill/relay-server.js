// ============================================================================
// CloudHand Relay Server — OpenClaw Skill 运行时组件
// 
// 核心职责：
// 1. WebSocket 中继：连接本地终端与 Web UI 页面。
// 2. Token 注册：基于本地持久化 Token 自动注册/识别机器。
// 3. Agent 转发：将 AI 对话请求转发给本地 claude-driver（PTY 模式）执行。
//    relay-server 不直接执行 Claude，所有执行都在用户本地电脑上完成。
// ============================================================================

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 配置信息
const config = {
  port: process.argv.includes('--port') ? parseInt(process.argv[process.argv.indexOf('--port') + 1]) : 3456,
  clientsFile: path.join(__dirname, 'clients.json')
};

// ==================== 状态管理 ====================

// 持久化注册表：Map<token, {computer_name, lastSeen, connected}>
let clientRegistry = new Map();

// 活跃连接：Map<token, WebSocket>
const terminalClients = new Map();     // 目标本地机器
const uiClients = new Set();           // 浏览器 UI 客户端

// 加载持久化数据
function loadRegistry() {
  if (fs.existsSync(config.clientsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(config.clientsFile, 'utf8'));
      for (const [token, info] of Object.entries(data)) {
        clientRegistry.set(token, { ...info, connected: false });
      }
    } catch (e) {
      console.error('[Registry] ❌ 数据加载失败:', e.message);
    }
  }
}

// 保存持久化数据
function saveRegistry() {
  const data = {};
  for (const [token, info] of clientRegistry.entries()) {
    const { computer_name, lastSeen } = info;
    data[token] = { computer_name, lastSeen };
  }
  fs.writeFileSync(config.clientsFile, JSON.stringify(data, null, 2));
}

// 注册或更新客户端
function upsertClient(token, computerName) {
  const now = Date.now();
  clientRegistry.set(token, {
    computer_name: computerName,
    lastSeen: now,
    connected: true
  });
  saveRegistry();
}

// 检查 Token 是否已知（在注册表中）
function isTokenKnown(token) {
  return clientRegistry.has(token);
}

// 定时清理（仅从注册表中移除 1 小时未连接的机器）
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, info] of clientRegistry.entries()) {
    if (!terminalClients.has(token) && (now - info.lastSeen > 3600000)) {
      clientRegistry.delete(token);
      changed = true;
    }
  }
  if (changed) saveRegistry();
}, 600000);

loadRegistry();

// ==================== HTTP 服务 ====================

const server = http.createServer((req, res) => {
  const urlObj = url.parse(req.url, true);

  // 静态页面路由
  if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/index.html')) {
    // 根据 Token 自动路由
    const cookies = parseCookies(req);
    const token = urlObj.query.token || cookies.token;

    if (token && clientRegistry.has(token)) {
      // 访问 UI 页面
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'ui.html')));
    } else {
      // 未知设备，显示登录/提示页
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'login.html')));
    }
    return;
  }

  // API 接口：获取所有连接详情
  if (req.method === 'GET' && urlObj.pathname === '/api/clients') {
    const clients = [];
    for (const [token, info] of clientRegistry.entries()) {
      clients.push({
        token_prefix: token.substring(0, 8) + '...',
        computer_name: info.computer_name,
        connected: terminalClients.has(token),
        lastSeen: info.lastSeen
      });
    }
    return jsonResponse(res, 200, clients);
  }

  // ==================== Agent API 路由 ====================

  // 仅限本地访问驱动指令功能 (POST)
  // GET 请求 (status, history, stream) 允许 Web UI 远程查阅，但必须校验 token
  if (req.url.startsWith('/agent/')) {
    const cookies = parseCookies(req);
    const reqToken = urlObj.query.token || cookies.token;

    if (req.method === 'POST') {
      if (!isLocalRequest(req)) {
        return jsonResponse(res, 403, { error: 'Forbidden', message: 'Local access only for Agent control' });
      }
    } else if (req.method === 'GET') {
      if (!reqToken || !isTokenKnown(reqToken)) {
        return jsonResponse(res, 401, { error: 'Unauthorized', message: 'Invalid or missing token' });
      }
    }

    // POST /agent/start — 初始化 Agent 会话（通知本地启动 claude-driver PTY）
    if (req.method === 'POST' && req.url === '/agent/start') {
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.token) {
            return jsonResponse(res, 400, { ok: false, error: '缺少 token 字段，必须指定目标机器' });
          }
          if (!terminalClients.has(data.token)) {
            return jsonResponse(res, 404, { ok: false, error: '该机器不在线或未注册' });
          }
          if (agent.state !== 'offline') {
            return jsonResponse(res, 400, { ok: false, error: 'Agent 已在运行，请先 stop' });
          }
          agent.token = data.token;
          agent.state = 'idle';
          agent.history = [];
          agent.totalTurns = 0;
          agent.pendingRequest = null;

          // 通知本地启动 claude-driver（PTY 模式）
          const termWs = terminalClients.get(data.token);
          termWs.send(JSON.stringify({ type: 'agent_start' }));

          console.log(`[Agent] ✅ 已初始化，目标机器: ${data.token}`);
          jsonResponse(res, 200, { ok: true, state: 'idle', targetToken: agent.token });
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: '请求体 JSON 解析失败' });
        }
      });
      return;
    }

    // POST /agent/send — 发送消息，转发给本地 claude-driver 执行
    if (req.method === 'POST' && req.url === '/agent/send') {
      readBody(req, (body) => {
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
          if (agent.state === 'waiting_permission') {
            return jsonResponse(res, 409, { ok: false, error: 'Agent 正在等待权限决策，请先调用 /agent/permission' });
          }

          const termWs = terminalClients.get(agent.token);
          if (!termWs || termWs.readyState !== 1) {
            agent.state = 'offline';
            return jsonResponse(res, 503, { ok: false, error: '目标本地机器已离线' });
          }

          const requestId = generateRequestId();
          agent.history.push({ role: 'openclaw', message, timestamp: Date.now() });
          agent.state = 'busy';
          emitToStreamClients({ type: 'status', state: 'busy' });

          // 转发给本地 claude-driver（PTY 模式），只传 message
          termWs.send(JSON.stringify({
            type: 'agent_query',
            requestId,
            message
          }));

          // PTY 模式下 Claude 可能执行较长时间，超时 600s
          const timeout = setTimeout(() => {
            if (agent.pendingRequest?.requestId === requestId) {
              const savedRes = agent.pendingRequest.res;
              agent.pendingRequest = null;
              agent.state = 'idle';
              emitToStreamClients({ type: 'status', state: 'idle' });
              jsonResponse(savedRes, 504, { ok: false, error: '本地执行超时 (600s)' });
            }
          }, 600000);

          agent.pendingRequest = { requestId, res, timeout };
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: '请求体 JSON 解析失败' });
        }
      });
      return;
    }

    // GET /agent/status — 查询状态
    if (req.method === 'GET' && req.url === '/agent/status') {
      const isOwner = agent.token === reqToken;
      jsonResponse(res, 200, {
        state: isOwner ? agent.state : 'offline',
        totalTurns: isOwner ? agent.totalTurns : 0
      });
      return;
    }

    // GET /agent/stream — SSE 实时事件流
    if (req.method === 'GET' && req.url === '/agent/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const stateToEmit = (agent.token === reqToken) ? agent.state : 'offline';
      res.write(`data: ${JSON.stringify({ type: 'status', state: stateToEmit })}\n\n`);
      
      // 注意：目前 streamClients 是全局 Set，实际应做到 per-token 或在发流时检查所有者的 res。
      // 为保持简单，暂时存入，广播时只发给对应的（目前 emitToStreamClients 不区分 token）。
      agent.streamClients.add(res);
      req.on('close', () => {
        agent.streamClients.delete(res);
      });
      return;
    }

    // GET /agent/history — 获取对话历史
    if (req.method === 'GET' && (req.url === '/agent/history' || req.url.startsWith('/agent/history?'))) {
      const isOwner = agent.token === reqToken;
      jsonResponse(res, 200, {
        ok: true,
        history: isOwner ? agent.history : [],
        state: isOwner ? agent.state : 'offline'
      });
      return;
    }

    // POST /agent/permission — OpenClaw 发送权限决策
    if (req.method === 'POST' && req.url === '/agent/permission') {
      readBody(req, (body) => {
        try {
          const data = JSON.parse(body);
          if (agent.state !== 'waiting_permission') {
            return jsonResponse(res, 400, { ok: false, error: 'Agent 未在等待权限状态' });
          }
          const termWs = terminalClients.get(agent.token);
          if (!termWs || termWs.readyState !== 1) {
            agent.state = 'offline';
            return jsonResponse(res, 503, { ok: false, error: '目标机器已离线' });
          }

          // 转发权限决策给本地
          termWs.send(JSON.stringify({
            type: 'agent_permission',
            allow: !!data.allow
          }));

          agent.state = 'busy';
          emitToStreamClients({ type: 'status', state: 'busy' });

          // 设置新的 pending request，等待权限处理后的结果
          const requestId = agent.lastRequestId;
          const timeout = setTimeout(() => {
            if (agent.pendingRequest?.requestId === requestId) {
              const savedRes = agent.pendingRequest.res;
              agent.pendingRequest = null;
              agent.state = 'idle';
              emitToStreamClients({ type: 'status', state: 'idle' });
              jsonResponse(savedRes, 504, { ok: false, error: '权限放行后执行超时 (600s)' });
            }
          }, 600000);

          agent.pendingRequest = { requestId, res, timeout };
          // 注意：这里不回复 HTTP，等待下一个 agent_result 回调
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: 'JSON 解析失败' });
        }
      });
      return;
    }

    // POST /agent/stop — 关闭会话，通知本地停止 claude-driver
    if (req.method === 'POST' && req.url === '/agent/stop') {
      // 如果有等待中的请求，先回复超时
      if (agent.pendingRequest) {
        clearTimeout(agent.pendingRequest.timeout);
        try { jsonResponse(agent.pendingRequest.res, 499, { ok: false, error: 'Agent 被手动停止' }); } catch {}
        agent.pendingRequest = null;
      }
      // 通知本地停止 claude-driver PTY
      const termWs = terminalClients.get(agent.token);
      if (termWs && termWs.readyState === WebSocket.OPEN) {
        termWs.send(JSON.stringify({ type: 'agent_stop' }));
      }
      agent.state = 'offline';
      agent.token = null;
      console.log('[Agent] 🛑 已停止');
      jsonResponse(res, 200, { ok: true, state: 'offline' });
      return;
    }

    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

// ==================== WebSocket 服务 ====================

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const urlObj = url.parse(request.url, true);

  if (urlObj.pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => handleTerminalConnection(ws));
  } else if (urlObj.pathname === '/ws/ui') {
    // 从 query 或 cookie 获取 token
    let token = urlObj.query.token;
    if (!token) {
      const cookieStr = request.headers.cookie || '';
      const match = cookieStr.match(/token=([^;]+)/);
      if (match) token = match[1];
    }
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

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: '认证超时' }));
      ws.close();
    }
  }, 10000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authenticated) {
      if (msg.type === 'auth') {
        const token = msg.token;
        const computerName = msg.computer_name;
        // 验证 token 格式有效性（避免无效连接）
        if (!token || token.length < 16) {
          ws.send(JSON.stringify({ type: 'auth_fail', reason: '无效 token 格式' }));
          ws.close();
          return;
        }
        if (terminalClients.has(token)) {
          const oldWs = terminalClients.get(token);
          try { oldWs.close(); } catch {}
        }
        clearTimeout(authTimeout);
        authenticated = true;
        clientToken = token;
        upsertClient(token, computerName);
        terminalClients.set(token, ws);

        // 如果是正在保留中的 Agent 机器重连，清除离线计时器
        if (agent.token === token && agent.offlineTimer) {
          console.log(`[Agent] 🔄 目标机器 "${computerName}" 已在保留期内回传，会话恢复。`);
          clearTimeout(agent.offlineTimer);
          agent.offlineTimer = null;
        }

        const info = clientRegistry.get(token);
        ws.send(JSON.stringify({ type: 'auth_ok', computer_name: info.computer_name }));
        broadcastToUIByToken(token, { type: 'terminal_connected', computer_name: info.computer_name });
        console.log(`[中继] ✅ 终端已连接: "${info.computer_name}"`);
      }
      return;
    }

    if (['output', 'session_created', 'session_closed', 'session_exit', 'session_list'].includes(msg.type)) {
      broadcastToUIByToken(clientToken, msg);
    }

    // Agent 专有消息处理
    if (msg.type === 'agent_stream') {
      emitToStreamClients(msg.event);
    }
    // claude-driver 回传结果（区分完成/权限请求）
    if (msg.type === 'agent_result') {
      // 权限请求 — 返回给 OpenClaw 决策
      if (msg.status === 'permission_request') {
        if (agent.pendingRequest) {
          clearTimeout(agent.pendingRequest.timeout);
          const savedRes = agent.pendingRequest.res;
          agent.pendingRequest = null;
          agent.state = 'waiting_permission';
          agent.lastRequestId = msg.requestId;
          emitToStreamClients({ type: 'permission_request', prompt: msg.prompt });
          jsonResponse(savedRes, 200, {
            ok: true,
            needsPermission: true,
            prompt: msg.prompt
          });
        }
        return;
      }

      // 正常完成
      if (agent.pendingRequest && agent.pendingRequest.requestId === msg.requestId) {
        clearTimeout(agent.pendingRequest.timeout);
        const savedRes = agent.pendingRequest.res;
        agent.pendingRequest = null;
        agent.state = 'idle';

        // 区分错误回复和正常回复，错误不计入 history
        const isError = msg.reply && msg.reply.startsWith('[ERROR]');
        if (!isError) {
          agent.totalTurns++;
          agent.history.push({ 
            role: 'claude', 
            message: msg.reply,
            timestamp: Date.now() 
          });
        } else {
          // 错误回复时也移除对应的 openclaw 消息（避免重试污染 history）
          if (agent.history.length > 0 && agent.history[agent.history.length - 1].role === 'openclaw') {
            agent.history.pop();
          }
        }

        emitToStreamClients({ type: 'status', state: 'idle' });
        jsonResponse(savedRes, 200, { 
          ok: !isError, 
          reply: msg.reply
        });
      }
    }
  });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (clientToken && terminalClients.get(clientToken) === ws) {
        terminalClients.delete(clientToken);
        broadcastToUIByToken(clientToken, { type: 'terminal_disconnected' });
        console.log(`[中继] ❌ 终端已断开: ${clientToken}`);
  
        // 如果 agent 关联该 token，启动延迟重置计时器 (5分钟)
        if (agent.token === clientToken) {
          console.log(`[Agent] ⚠️ 目标机器断开，启动 5 分钟会话保留计时器...`);
          agent.offlineTimer = setTimeout(() => {
            if (agent.token === clientToken && !terminalClients.has(clientToken)) {
              if (agent.pendingRequest) {
                clearTimeout(agent.pendingRequest.timeout);
                try { jsonResponse(agent.pendingRequest.res, 503, { ok: false, error: '目标机器已断开' }); } catch {}
                agent.pendingRequest = null;
              }
              agent.state = 'offline';
              agent.token = null;
              console.log('[Agent] 🛑 5 分钟超时，Agent 已彻底重置');
            }
          }, 300000);
        }
      }
    });
}

// ---- 浏览器 UI 连接处理 ----

function handleUIConnection(ws, req, token) {
  const client = { ws, token };
  uiClients.add(client);

  const info = clientRegistry.get(token);
  ws.send(JSON.stringify({
    type: 'init',
    terminalConnected: !!(terminalClients.has(token)),
    computer_name: info.computer_name
  }));

  const termWs = terminalClients.get(token);
  if (termWs) termWs.send(JSON.stringify({ type: 'list_sessions' }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (['input', 'create_session', 'close_session', 'resize', 'list_sessions'].includes(msg.type)) {
      const tw = terminalClients.get(token);
      if (tw && tw.readyState === WebSocket.OPEN) tw.send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => uiClients.delete(client));
}

// ==================== 工具函数 ====================

function broadcastToUIByToken(token, data) {
  const payload = JSON.stringify(data);
  for (const client of uiClients) {
    if (client.token === token && client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
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
  req.on('data', chunk => body += chunk);
  req.on('end', () => cb(body));
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function isLocalRequest(req) {
  const remoteAddr = req.socket.remoteAddress;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);
}

// ==================== Agent 状态 ====================

const agent = {
  state: 'offline',    // offline | idle | busy | waiting_permission
  token: null,         // 目标机器 token
  history: [],         // AI-to-AI 对话历史
  totalTurns: 0,       // 累计对话轮次
  pendingRequest: null, // 等待中的 HTTP 请求 { requestId, res, timeout }
  lastRequestId: null, // 最后一个 requestId（用于权限流程）
  streamClients: new Set(), // SSE 客户端
  offlineTimer: null    // 离线保留计时器
};

function generateRequestId() {
  return Math.random().toString(36).substring(2, 11);
}

function emitToStreamClients(event) {
  if (agent.streamClients.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of agent.streamClients) {
    try { res.write(payload); } catch (e) {}
  }
}

// ==================== 启动 ====================

server.listen(config.port, () => {
  console.log(`[中继] 启动成功，监听端口: ${config.port}`);
});
