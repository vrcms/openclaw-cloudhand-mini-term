const { WebSocketServer } = require('ws');
const EventEmitter = require('events');

// 远程 WS 服务器 — 等待 AI 智能体连入
class RemoteWsServer extends EventEmitter {
  constructor({ port, authManager, sessionManager }) {
    super();
    this.authManager = authManager;
    this.sessionManager = sessionManager;
    this.client = null;
    this.clientToken = null;

    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this._handleConnection(ws));

    // PTY 输出转发到远程客户端（base64 编码保证二进制安全）
    this.sessionManager.on('output', ({ sessionId, data }) => {
      this._sendToClient({
        type: 'output',
        sessionId,
        data
      });
    });

    this.sessionManager.on('exit', ({ sessionId, exitCode }) => {
      this._sendToClient({ type: 'session_exit', sessionId, exitCode });
    });

    this.sessionManager.on('created', (session) => {
      this._sendToClient({
        type: 'session_created',
        sessionId: session.id,
        cwd: session.cwd,
        shell: session.shell
      });
    });

    this.sessionManager.on('closed', ({ sessionId }) => {
      this._sendToClient({ type: 'session_closed', sessionId });
    });

    console.log(`[远程 WS] 监听端口 ${port}`);
  }

  _handleConnection(ws) {
    // 只允许一个远程客户端
    if (this.client) {
      ws.send(JSON.stringify({ type: 'error', message: '已有客户端连接' }));
      ws.close();
      return;
    }

    let authenticated = false;

    // 10 秒内必须完成认证
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'auth_fail', reason: '认证超时' }));
        ws.close();
      }
    }, 10000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
        return;
      }

      if (!authenticated) {
        if (msg.type !== 'auth') {
          ws.send(JSON.stringify({ type: 'error', message: '请先认证' }));
          return;
        }
        if (this.authManager.verify(msg.pairCode)) {
          clearTimeout(authTimeout);
          const token = this.authManager.issueToken();
          this.client = ws;
          this.clientToken = token;
          authenticated = true;
          ws.send(JSON.stringify({ type: 'auth_ok', token }));
          this.emit('clientConnected');
          console.log('[远程 WS] 客户端认证成功');
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail', reason: '配对码错误' }));
        }
        return;
      }

      this._handleMessage(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (this.client === ws) {
        if (this.clientToken) this.authManager.revokeToken(this.clientToken);
        this.client = null;
        this.clientToken = null;
        this.emit('clientDisconnected');
        console.log('[远程 WS] 客户端已断开');
      }
    });

    ws.on('error', (err) => {
      console.error('[远程 WS] 连接错误:', err.message);
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
            shell: msg.shell,
            cols: msg.cols,
            rows: msg.rows
          });
          break;
        case 'close_session':
          this.sessionManager.closeSession(msg.sessionId);
          break;
        case 'list_sessions':
          ws.send(JSON.stringify({
            type: 'session_list',
            sessions: this.sessionManager.listSessions()
          }));
          break;
        case 'resize':
          this.sessionManager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${msg.type}` }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  }

  _sendToClient(data) {
    if (this.client && this.client.readyState === 1) {
      this.client.send(JSON.stringify(data));
    }
  }

  destroy() {
    this.wss.close();
  }
}

module.exports = RemoteWsServer;
