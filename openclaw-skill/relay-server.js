/**
 * CloudHand 中继服务器
 * 由 OpenClaw AI 智能体启动，桥接本地终端和远程 Web UI
 *
 * 用法: node relay-server.js --pair-code <CODE> --port <PORT>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ==================== 命令行参数解析 ====================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { port: 3456, pairCode: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--pair-code=')) {
      config.pairCode = args[i].split('=')[1];
    } else if (args[i] === '--pair-code' && args[i + 1]) {
      config.pairCode = args[i + 1];
      i++;
    } else if (args[i].startsWith('--port=')) {
      config.port = parseInt(args[i].split('=')[1]);
    } else if (args[i] === '--port' && args[i + 1]) {
      config.port = parseInt(args[i + 1]);
      i++;
    }
  }

  if (!config.pairCode) {
    console.error('错误: 必须指定 --pair-code 参数');
    process.exit(1);
  }

  return config;
}

const config = parseArgs();

// ==================== 状态管理 ====================

let terminalClient = null;       // 本地 CloudHand 应用的 WS 连接
const uiClients = new Set();     // 浏览器 Web UI 的 WS 连接集合

let currentPairCode = config.pairCode;
const validTokens = new Map(); // token -> { createdAt }
const TOKEN_MAX_AGE = 24 * 3600 * 1000; // 24小时 (毫秒)

function isTokenValid(token) {
  if (!token) return false;
  const info = validTokens.get(token);
  if (!info) return false;
  if (Date.now() - info.createdAt > TOKEN_MAX_AGE) {
    validTokens.delete(token);
    return false;
  }
  return true;
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

// ==================== HTTP 服务器 ====================

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 首页 — 检查 Token，返回 ui.html 或 login.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const cookies = parseCookies(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      if (isTokenValid(cookies.token)) {
        res.end(fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8'));
      } else {
        res.end(fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8'));
      }
    } catch (err) {
      res.writeHead(500);
      res.end('Failed to load UI files');
    }
    return;
  }

  // API: 验证配对码，签发 Token
  if (req.method === 'POST' && req.url === '/api/auth') {
    readBody(req, (body) => {
      try {
        const { pairCode } = JSON.parse(body);
        if (pairCode === currentPairCode) {
          const token = crypto.randomUUID();
          validTokens.set(token, { createdAt: Date.now() });
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          jsonResponse(res, 401, { error: 'Access Denied' });
        }
      } catch {
        jsonResponse(res, 400, { error: 'Bad Request' });
      }
    });
    return;
  }

  // API: 内网热更新配对码 (仅限本地 127.0.0.1 访问)
  if (req.method === 'POST' && req.url === '/api/internal/paircode') {
    const ip = req.socket.remoteAddress;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      jsonResponse(res, 403, { error: 'Forbidden' });
      return;
    }
    readBody(req, (body) => {
      try {
        const { pairCode } = JSON.parse(body);
        if (pairCode) {
          currentPairCode = String(pairCode);
          jsonResponse(res, 200, { ok: true, currentPairCode });
          console.log(`\n[中继] 🔐 配对码已被内网指令热更新`);
        } else {
          jsonResponse(res, 400, { error: 'Missing pairCode' });
        }
      } catch {
        jsonResponse(res, 400, { error: 'Bad Request' });
      }
    });
    return;
  }

  // API: AI 发送终端命令 (需要带 Token)
  if (req.method === 'POST' && req.url === '/api/exec') {
    let token = parseCookies(req).token;
    if (!token && req.headers.authorization) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!isTokenValid(token)) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    readBody(req, (body) => {
      try {
        const { command, sessionId } = JSON.parse(body);
        if (terminalClient && terminalClient.readyState === WebSocket.OPEN) {
          terminalClient.send(JSON.stringify({
            type: 'input',
            sessionId: sessionId || 'default',
            data: command
          }));
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, 503, { error: '终端未连接' });
        }
      } catch {
        jsonResponse(res, 400, { error: 'JSON 格式错误' });
      }
    });
    return;
  }

  // API: 连接状态
  if (req.method === 'GET' && req.url === '/api/status') {
    jsonResponse(res, 200, {
      terminalConnected: !!(terminalClient && terminalClient.readyState === WebSocket.OPEN),
      uiClients: uiClients.size
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ==================== WebSocket 服务器 ====================

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => handleTerminalConnection(ws));
  } else if (pathname === '/ws/ui') {
    let token = urlObj.searchParams.get('token');
    if (!token) {
      const cookieStr = request.headers.cookie || '';
      const match = cookieStr.match(/token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!isTokenValid(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleUIConnection(ws));
  } else {
    socket.destroy();
  }
});

// ---- 本地终端连接处理 ----

function handleTerminalConnection(ws) {
  // 只允许一个终端连接
  if (terminalClient) {
    ws.send(JSON.stringify({ type: 'error', message: '已有终端连接' }));
    ws.close();
    return;
  }

  let authenticated = false;

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
      if (msg.type === 'auth' && msg.pairCode === currentPairCode) {
        clearTimeout(authTimeout);
        authenticated = true;
        terminalClient = ws;
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        broadcastToUI({ type: 'terminal_connected' });
        console.log('[中继] ✅ 本地终端已连接并认证');
      } else if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_fail', reason: '配对码错误' }));
      }
      return;
    }

    // 认证后：终端消息转发给所有 UI 客户端
    if (['output', 'session_created', 'session_closed', 'session_exit', 'session_list'].includes(msg.type)) {
      broadcastToUI(msg);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (terminalClient === ws) {
      terminalClient = null;
      broadcastToUI({ type: 'terminal_disconnected' });
      console.log('[中继] ❌ 本地终端已断开');
    }
  });

  ws.on('error', (err) => {
    console.error('[中继] 终端连接错误:', err.message);
  });
}

// ---- 浏览器 UI 连接处理 ----

function handleUIConnection(ws) {
  uiClients.add(ws);

  // 发送当前状态
  ws.send(JSON.stringify({
    type: 'init',
    terminalConnected: !!(terminalClient && terminalClient.readyState === WebSocket.OPEN)
  }));

  // 如果终端已连接，请求会话列表
  if (terminalClient && terminalClient.readyState === WebSocket.OPEN) {
    terminalClient.send(JSON.stringify({ type: 'list_sessions' }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      // 终端操作：转发给本地终端
      case 'input':
      case 'create_session':
      case 'close_session':
      case 'resize':
      case 'list_sessions':
        if (terminalClient && terminalClient.readyState === WebSocket.OPEN) {
          terminalClient.send(JSON.stringify(msg));
        }
        break;
    }
  });

  ws.on('close', () => {
    uiClients.delete(ws);
  });
}

// ==================== 工具函数 ====================

function broadcastToUI(data) {
  const payload = JSON.stringify(data);
  for (const ws of uiClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
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

// ==================== 启动 ====================

server.listen(config.port, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║       ☁️  CloudHand Relay Server               ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  Web UI:    http://localhost:${config.port}`);
  console.log(`║  WS 终端:   ws://localhost:${config.port}/ws/terminal`);
  console.log(`║  WS UI:     ws://localhost:${config.port}/ws/ui`);
  console.log(`║  配对码:    🔑 ${config.pairCode}`);
  console.log('║  状态:      ⏳ 等待本地终端连接...');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});

