const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

// 本地 HTTP + WS 服务器 — 提供前端 UI 和本地终端交互
class LocalServer {
  constructor({ port, authManager, sessionManager }) {
    this.authManager = authManager;
    this.sessionManager = sessionManager;
    this.localClients = new Set();

    const app = express();

    // 静态文件服务
    app.use(express.static(path.join(__dirname, '..', 'public')));

    // 映射 xterm.js CSS（JS 通过 esbuild 打包，CSS 直接引用）
    app.use('/lib/xterm', express.static(
      path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')
    ));

    this.server = http.createServer(app);
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this._handleConnection(ws));

    // 监听 PTY 事件，广播给本地前端
    this.sessionManager.on('output', ({ sessionId, data }) => {
      this._broadcast({
        type: 'output',
        sessionId,
        data
      });
    });

    this.sessionManager.on('created', (session) => {
      this._broadcast({
        type: 'session_created',
        sessionId: session.id,
        cwd: session.cwd,
        shell: session.shell,
        createdAt: session.createdAt
      });
    });

    this.sessionManager.on('closed', ({ sessionId }) => {
      this._broadcast({ type: 'session_closed', sessionId });
    });

    this.sessionManager.on('exit', ({ sessionId, exitCode }) => {
      this._broadcast({ type: 'session_exit', sessionId, exitCode });
    });

    // 配对码刷新通知前端
    this.authManager.on('pairCodeChanged', (info) => {
      this._broadcast({ type: 'pair_code', ...info });
    });

    this.server.listen(port, () => {
      console.log(`[本地 UI] http://localhost:${port}`);
    });
  }

  _handleConnection(ws) {
    this.localClients.add(ws);

    // 发送当前配对码
    ws.send(JSON.stringify({
      type: 'pair_code',
      ...this.authManager.getPairCode()
    }));

    // 发送当前会话列表
    ws.send(JSON.stringify({
      type: 'session_list',
      sessions: this.sessionManager.listSessions()
    }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this._handleMessage(ws, msg);
    });

    ws.on('close', () => {
      this.localClients.delete(ws);
    });
  }

  _handleMessage(ws, msg) {
    try {
      switch (msg.type) {
        case 'input':
          this.sessionManager.write(msg.sessionId, msg.data);
          break;
        case 'create_session':
          this.sessionManager.createSession({
            cwd: msg.cwd,
            shell: msg.shell
          });
          break;
        case 'close_session':
          this.sessionManager.closeSession(msg.sessionId);
          break;
        case 'resize':
          this.sessionManager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  }

  // 广播给所有本地前端
  _broadcast(data) {
    const payload = JSON.stringify(data);
    for (const ws of this.localClients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  // 广播远程客户端连接状态
  broadcastRemoteStatus(connected) {
    this._broadcast({
      type: connected ? 'remote_connected' : 'remote_disconnected'
    });
  }

  destroy() {
    this.server.close();
  }
}

module.exports = LocalServer;
