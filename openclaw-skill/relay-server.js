// ============================================================================
// CloudHand Relay Server — OpenClaw Skill 运行时组件
// 
// 核心职责：
// 1. WebSocket 中继：连接本地终端与 Web UI 页面。
// 2. Token 注册：基于本地持久化 Token 自动注册/识别机器。
// 3. Agent 转发：将 AI 对话请求转发给本地机器执行 Claude CLI。
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
          agent.cwd = data.cwd || null;
          agent.allowedTools = data.allowedTools || ['Read', 'Edit', 'Bash', 'Write'];
          agent.state = 'idle';
          agent.sessionId = null;
          agent.history = [];
          agent.totalTurns = 0;
          agent.pendingRequest = null;
          console.log(`[Agent] ✅ 已初始化目标机器: ${data.token}`);
          jsonResponse(res, 200, { ok: true, state: 'idle', targetToken: agent.token });
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: '请求体 JSON 解析失败' });
        }
      });
      return;
    }

    // POST /agent/send — 发送消息并等待 Claude 回复 (通过转发给本地)
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

          const termWs = terminalClients.get(agent.token);
          if (!termWs || termWs.readyState !== 1) {
            agent.state = 'offline';
            return jsonResponse(res, 503, { ok: false, error: '目标本地机器已离线' });
          }

          const requestId = generateRequestId();
          agent.history.push({ role: 'openclaw', message, timestamp: Date.now() });
          agent.state = 'busy';
          emitToStreamClients({ type: 'status', state: 'busy' });

          // 发送指令给本地
          termWs.send(JSON.stringify({
            type: 'agent_query',
            requestId,
            message,
            sessionId: agent.sessionId,
            allowedTools: agent.allowedTools,
            cwd: agent.cwd
          }));

          // 创建 Promise 并存储 res 以便回调
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              if (agent.pendingRequest?.requestId === requestId) {
                const savedRes = agent.pendingRequest.res;
                agent.pendingRequest = null;
                agent.state = 'idle';
                jsonResponse(savedRes, 504, { ok: false, error: '本地执行超时 (180s)' });
              }
            }, 180000);

            agent.pendingRequest = { requestId, res, timeout };
          });
          // 注意：此处不再 resolve，由 Webhook 触发
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

    // GET /agent/stream — SSE 实时事件流
    if (req.method === 'GET' && req.url === '/agent/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`data: ${JSON.stringify({ type: 'status', state: agent.state, sessionId: agent.sessionId })}\n\n`);
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
      if (agent.state === 'busy') {
        const termWs = terminalClients.get(agent.token);
        if (termWs) termWs.send(JSON.stringify({ type: 'agent_abort' }));
      }
      agent.state = 'offline';
      agent.token = null;
      agent.pendingRequest = null;
      console.log('[Agent] 🛑 已停止 Agent 会话');
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
    if (msg.type === 'agent_result') {
      if (agent.pendingRequest && agent.pendingRequest.requestId === msg.requestId) {
        clearTimeout(agent.pendingRequest.timeout);
        const savedRes = agent.pendingRequest.res;
        agent.pendingRequest = null;
        agent.state = 'idle';
        agent.sessionId = msg.sessionId || agent.sessionId;
        agent.totalTurns++;
        agent.history.push({ role: 'claude', message: msg.reply, exitCode: msg.exitCode, timestamp: Date.now() });
        emitToStreamClients({ type: 'status', state: 'idle' });
        jsonResponse(savedRes, 200, { ok: msg.exitCode === 0, reply: msg.reply, sessionId: msg.sessionId, exitCode: msg.exitCode });
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (clientToken && terminalClients.get(clientToken) === ws) {
      terminalClients.delete(clientToken);
      broadcastToUIByToken(clientToken, { type: 'terminal_disconnected' });
      console.log(`[中继] ❌ 终端已断开: ${clientToken}`);
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
  state: 'offline',
  token: null,
  sessionId: null,
  cwd: null,
  allowedTools: [],
  history: [],
  totalTurns: 0,
  pendingRequest: null,
  streamClients: new Set()
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
