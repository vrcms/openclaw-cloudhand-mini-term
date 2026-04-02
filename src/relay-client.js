const WebSocket = require('ws');
const EventEmitter = require('events');
const { spawn } = require('child_process');

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
    this._agentProcess = null; // 当前正在运行的 Agent 进程 (Claude CLI)

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
        case 'agent_query':
          this._handleAgentQuery(msg);
          break;
        case 'agent_abort':
          this._handleAgentAbort(msg);
          break;
      }
    } catch (err) {
      this._send({ type: 'error', message: err.message });
    }
  }

  // 处理来自中继的 Agent 任务
  _handleAgentQuery(msg) {
    const { requestId, message, sessionId, allowedTools, cwd } = msg;

    // 如果已有进程在跑，先杀掉
    if (this._agentProcess) {
      this._handleAgentAbort();
    }

    const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));

    console.log(`[Agent] 🚀 本地执行: claude ${args.slice(0, 4).join(' ')}...`);

    const proc = spawn('claude', args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    this._agentProcess = proc;
    proc.stdin.end();

    let stdoutBuffer = '';
    let fullRawStdout = '';
    let stderr = '';
    let extractedText = '';
    let extractedSessionId = null;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullRawStdout += text;
      stdoutBuffer += text;

      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        try {
          const event = JSON.parse(line);
          if (event.session_id && !extractedSessionId) extractedSessionId = event.session_id;

          // 转发原始事件片段给中继 (用于 SSE 实时流)
          this._send({ type: 'agent_stream', requestId, event });

          // 提取文本
          if (event.type === 'assistant' && event.message?.content) {
            const parts = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
            for (const part of parts) {
              if (typeof part === 'string') extractedText += part;
              else if (part.type === 'text' && part.text) extractedText += part.text;
            }
          }
          if (event.type === 'result' && event.result && !extractedText) extractedText = event.result;
        } catch (e) {}
      }
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      console.log(`[Agent] ✅ 进程结束 (code: ${code})`);
      this._agentProcess = null;
      this._send({
        type: 'agent_result',
        requestId,
        reply: extractedText.trim() || fullRawStdout || stderr || '(执行完成，无输出)',
        exitCode: code || 0,
        sessionId: extractedSessionId
      });
    });

    proc.on('error', (err) => {
      this._agentProcess = null;
      this._send({
        type: 'agent_result',
        requestId,
        reply: `[ERROR] 启动失败: ${err.message}`,
        exitCode: -1
      });
    });
  }

  // 中断当前 Agent 进程
  _handleAgentAbort() {
    if (this._agentProcess) {
      console.log('[Agent] 🛑 中断执行');
      try { this._agentProcess.kill(); } catch (e) {}
      this._agentProcess = null;
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
    this._handleAgentAbort();
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();

    this.sessionManager.off('output', this._onOutput);
    this.sessionManager.off('created', this._onCreated);
    this.sessionManager.off('closed', this._onClosed);
    this.sessionManager.off('exit', this._onExit);
  }
}

module.exports = RelayClient;
