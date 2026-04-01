/**
 * CloudHand 中继服务器
 * 由 OpenClaw AI 智能体启动，桥接本地终端和远程 Web UI
 *
 * 用法: node relay-server.js [--pair-code <CODE>] --port <PORT>
 * 配对码可选：不填则只放行 token 流量
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

  // 配对码不再强制要求，为空表示暂不接受配对
  return config;
}

const config = parseArgs();

// ==================== 状态管理 ====================

let terminalClient = null;       // 本地 CloudHand 应用的 WS 连接
const uiClients = new Set();     // 浏览器 Web UI 的 WS 连接集合

let currentPairCode = config.pairCode || null;
let pairCodeTimer = null;        // 配对码过期计时器
const PAIR_CODE_TTL = 5 * 60 * 1000; // 配对码 5 分钟有效

const validTokens = new Map(); // token -> { createdAt }
const TOKEN_MAX_AGE = 24 * 3600 * 1000; // 24小时 (毫秒)

// ---- 配对码管理 ----

function setPairCode(code) {
  // 清除旧的过期计时器
  if (pairCodeTimer) {
    clearTimeout(pairCodeTimer);
    pairCodeTimer = null;
  }

  currentPairCode = code ? String(code) : null;

  if (currentPairCode) {
    // 启动 5 分钟过期计时器
    pairCodeTimer = setTimeout(() => {
      console.log(`\n[中继] ⏰ 配对码已过期（5分钟），已自动清空`);
      currentPairCode = null;
      pairCodeTimer = null;
    }, PAIR_CODE_TTL);
    console.log(`\n[中继] 🔐 配对码已设置，5 分钟内有效`);
  }
}

// 如果启动时带了配对码，启动过期计时器
if (currentPairCode) {
  pairCodeTimer = setTimeout(() => {
    console.log(`\n[中继] ⏰ 配对码已过期（5分钟），已自动清空`);
    currentPairCode = null;
    pairCodeTimer = null;
  }, PAIR_CODE_TTL);
}

// ---- Token 管理 ----

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

function issueToken() {
  const token = crypto.randomUUID();
  validTokens.set(token, { createdAt: Date.now() });
  return token;
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

  // 首页 — 处理 URL token 参数 或 cookie token
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?'))) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const queryToken = urlObj.searchParams.get('token');
    const cookies = parseCookies(req);

    // URL 带 token：验证后设置 cookie 并直接返回 UI（不重定向，避免 cookie 丢失）
    if (queryToken) {
      if (isTokenValid(queryToken)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `token=${queryToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        });
        res.end(loadHtmlFile('ui.html'));
      } else {
        // token 无效，显示提示页
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loadHtmlFile('login.html'));
      }
      return;
    }

    // Cookie 中有有效 token → 显示终端 UI
    if (isTokenValid(cookies.token)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loadHtmlFile('ui.html'));
      return;
    }

    // 无有效 token → 显示提示页
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loadHtmlFile('login.html'));
    return;
  }

  // API: 验证配对码，签发 Token（供网页端使用，保留兼容）
  if (req.method === 'POST' && req.url === '/api/auth') {
    readBody(req, (body) => {
      try {
        const { pairCode } = JSON.parse(body);
        if (currentPairCode && pairCode === currentPairCode) {
          const token = issueToken();
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
          setPairCode(pairCode);
          jsonResponse(res, 200, { ok: true, currentPairCode });
        } else {
          // 允许清空配对码
          setPairCode(null);
          jsonResponse(res, 200, { ok: true, currentPairCode: null });
        }
      } catch {
        jsonResponse(res, 400, { error: 'Bad Request' });
      }
    });
    return;
  }

  // API: 连接状态
  if (req.method === 'GET' && req.url === '/api/status') {
    jsonResponse(res, 200, {
      terminalConnected: !!(terminalClient && terminalClient.readyState === WebSocket.OPEN),
      uiClients: uiClients.size,
      hasPairCode: !!currentPairCode
    });
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
    wss.handleUpgrade(request, socket, head, (ws) => handleUIConnection(ws, request));
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
      if (msg.type === 'auth') {
        // 方式一：token 认证（断线重连/重启恢复）
        if (msg.token && isTokenValid(msg.token)) {
          clearTimeout(authTimeout);
          authenticated = true;
          terminalClient = ws;
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          broadcastToUI({ type: 'terminal_connected' });
          console.log('[中继] ✅ 本地终端已通过 token 认证连接');
          return;
        }

        // 方式二：配对码认证（首次配对）
        if (msg.pairCode) {
          if (!currentPairCode) {
            ws.send(JSON.stringify({ type: 'auth_fail', reason: '中继暂无配对码，请先让 OpenClaw 设置' }));
            return;
          }
          if (msg.pairCode === currentPairCode) {
            clearTimeout(authTimeout);
            authenticated = true;
            terminalClient = ws;

            // 签发 token 给终端（用于后续重连）
            const token = issueToken();
            ws.send(JSON.stringify({ type: 'auth_ok', token }));
            broadcastToUI({ type: 'terminal_connected' });

            // 配对成功后清空配对码（一次性使用）
            setPairCode(null);

            console.log('[中继] ✅ 本地终端已通过配对码认证，已签发 token');
            return;
          } else {
            ws.send(JSON.stringify({ type: 'auth_fail', reason: '配对码错误' }));
            return;
          }
        }

        // 没提供有效凭证
        ws.send(JSON.stringify({ type: 'auth_fail', reason: '请提供配对码或 token' }));
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

function handleUIConnection(ws, req) {
  uiClients.add(ws);

  // 触发连接成功的事件
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[EVENT] UI_CLIENT_CONNECTED IP: ${clientIp}`);

  // 如果配置了 NOTIFY_WEBHOOK，则向外发送通知
  // 触发连接成功的事件，供监控通道截获
  console.log(`[EVENT] 当前总共 ${uiClients.size} 个连接在你的电脑上`);

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
  console.log(`║  配对码:    ${currentPairCode ? '🔑 ' + currentPairCode + ' (5分钟有效)' : '⏸️  未设置 (仅放行 token 流量)'}`);
  console.log('║  状态:      ⏳ 等待本地终端连接...');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});
