const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * 中继客户端 — 主动连接到远程中继服务器，桥接本地 PTY 会话
 */
class RelayClient extends EventEmitter {
  constructor({ relayHost, pairCode, sessionManager }) {
    super();
    this.relayHost = relayHost;
    this.pairCode = pairCode;
    this.sessionManager = sessionManager;
    this.ws = null;
    this.authenticated = false;
    this.reconnectTimer = null;
    this._destroyed = false;

    // 监听 PTY 事件，转发到中继服务器
    this._onOutput = ({ sessionId, data }) => this._send({ type: 'output', sessionId, data });
    this._onCreated = (session) => this._send({ type: 'session_created', sessionId: session.id, cwd: session.cwd, shell: session.shell });
    this._onClosed = ({ sessionId }) => this._send({ type: 'session_closed', sessionId });
    this._onExit = ({ sessionId, exitCode }) => this._send({ type: 'session_exit', sessionId, exitCode });

    this.sessionManager.on('output', this._onOutput);
    this.sessionManager.on('created', this._onCreated);
    this.sessionManager.on('closed', this._onClosed);
    this.sessionManager.on('exit', this._onExit);
  }

  // 连接到中继服务器
  connect() {
    // 解析地址，构造 WS URL
    let host = this.relayHost.replace(/^(wss?|https?):\/\//, '');
    const isSecure = this.relayHost.startsWith('wss://') || this.relayHost.startsWith('https://');
    const protocol = isSecure ? 'wss' : 'ws';
    const url = `${protocol}://${host}/ws/terminal`;

    console.log(`[中继客户端] 正在连接 ${url} ...`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[中继客户端] 已连接，正在认证...');
      this.ws.send(JSON.stringify({ type: 'auth', pairCode: this.pairCode }));
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!this.authenticated) {
        if (msg.type === 'auth_ok') {
          this.authenticated = true;
          console.log('[中继客户端] ✅ 认证成功！');
          // 认证成功后，自动创建一个默认 PTY 会话
          this.sessionManager.createSession();
        } else if (msg.type === 'auth_fail') {
          console.error(`[中继客户端] ❌ 认证失败: ${msg.reason}`);
          this.ws.close();
        }
        return;
      }

      // 处理来自中继的消息（Web UI 用户操作）
      this._handleMessage(msg);
    });

    this.ws.on('close', () => {
      this.authenticated = false;
      if (!this._destroyed) {
        console.log('[中继客户端] 连接断开，3秒后重连...');
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[中继客户端] 连接错误: ${err.message}`);
    });
  }

  // 处理来自中继的消息
  _handleMessage(msg) {
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
          this._send({
            type: 'session_list',
            sessions: this.sessionManager.listSessions()
          });
          break;
        case 'resize':
          this.sessionManager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
      }
    } catch (err) {
      this._send({ type: 'error', message: err.message });
    }
  }

  // 发送消息到中继
  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // 销毁连接
  destroy() {
    this._destroyed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    
    this.sessionManager.off('output', this._onOutput);
    this.sessionManager.off('created', this._onCreated);
    this.sessionManager.off('closed', this._onClosed);
    this.sessionManager.off('exit', this._onExit);
  }
}

module.exports = RelayClient;
