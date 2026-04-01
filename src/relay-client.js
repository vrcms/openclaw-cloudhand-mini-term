const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * 中继客户端 — 主动连接到远程中继服务器，桥接本地 PTY 会话
 *
 * 认证策略（v2 - Token 直连）：
 *   - 启动时持有持久化 Token + computer_name，直接发送认证
 *   - 断线后自动重连，使用同一 Token
 */
class RelayClient extends EventEmitter {
  constructor({ relayHost, token, computerName, sessionManager }) {
    super();
    this.relayHost = relayHost;
    this.token = token;
    this.computerName = computerName || '未命名';
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
    if (this._destroyed) return;

    // 解析地址，构造 WS URL
    let host = this.relayHost.replace(/^(wss?|https?):\/\//, '');
    const isSecure = this.relayHost.startsWith('wss://') || this.relayHost.startsWith('https://');
    const protocol = isSecure ? 'wss' : 'ws';
    const url = `${protocol}://${host}/ws/terminal`;

    console.log(`[中继客户端] 正在连接 ${url} ...`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[中继客户端] 已连接，正在认证...');
      this.emit('connected');

      // 直接用 Token + computer_name 认证
      if (this.token) {
        this.ws.send(JSON.stringify({
          type: 'auth',
          token: this.token,
          computer_name: this.computerName
        }));
      } else {
        console.error('[中继客户端] ❌ 无 Token，无法认证');
        this.ws.close();
      }
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!this.authenticated) {
        if (msg.type === 'auth_ok') {
          this.authenticated = true;
          this.emit('authenticated', { computerName: msg.computer_name });
          console.log('[中继客户端] ✅ 认证成功！');
        } else if (msg.type === 'auth_fail') {
          console.error(`[中继客户端] ❌ 认证失败: ${msg.reason}`);
          this.emit('auth_failed', { reason: msg.reason });
          this.ws.close();
        }
        return;
      }

      // 处理来自中继的消息（Web UI 用户操作）
      this._handleMessage(msg);
    });

    this.ws.on('close', () => {
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;
      this.emit('disconnected');

      if (!this._destroyed) {
        // 有 Token 时始终自动重连
        if (this.token) {
          console.log('[中继客户端] 连接断开，3秒后自动重连...');
          this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        } else {
          console.log('[中继客户端] 连接断开，无 Token 不再自动重连');
        }
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
