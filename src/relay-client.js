const WebSocket = require('ws');
const EventEmitter = require('events');
const pty = require('node-pty');
const { ClaudeTerminalCanvas, ClaudeOutputParser } = require('../ClaudeParserLib');

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
    this._agentDriver = null; // claude-driver PTY 实例

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
        case 'agent_start':
          this._handleAgentStart();
          break;
        case 'agent_query':
          this._handleAgentQuery(msg);
          break;
        case 'agent_permission':
          this._handleAgentPermission(msg);
          break;
        case 'agent_stop':
          this._handleAgentStop();
          break;
      }
    } catch (err) {
      this._send({ type: 'error', message: err.message });
    }
  }

  // ==================== Agent PTY Driver ====================

  // 启动 claude-driver PTY
  _handleAgentStart() {
    if (this._agentDriver && this._agentDriver.ptyProc) {
      console.log('[Agent] 🔄 检测到已有运行中的 PTY，正在执行热衔接...');
      // 检查当前状态，如果是 IDLE，立即同步给中继以确认可用性
      if (this._agentDriver.state === 'IDLE') {
        this._send({ type: 'agent_stream', event: { type: 'status', state: 'idle' } });
      }
      return;
    }

    // node-pty 在 Windows 上无法直接 spawn .cmd 文件，需通过 cmd.exe /c
    const CLAUDE_CMD = process.platform === 'win32' ? 'cmd.exe' : 'claude';
    const CLAUDE_ARGS = process.platform === 'win32'
      ? ['/c', 'claude', ...(process.env.CLAUDE_ARGS || '').split(',').filter(Boolean)]
      : (process.env.CLAUDE_ARGS || '').split(',').filter(Boolean);

    const PTY_COLS = 220;
    const PTY_ROWS = 3000;
    const IDLE_DEBOUNCE_MS = 1500;
    const STARTING_DEBOUNCE_MS = 60000;

    const driver = {
      ptyProc: null,
      canvas: new ClaudeTerminalCanvas(PTY_COLS, PTY_ROWS),
      state: 'STARTING',  // STARTING | IDLE | BUSY | WAITING_FOR_BUSY | _PERMISSION
      idleTimer: null,
      taskResolveFn: null,
      taskRejectFn: null,
      taskTimer: null,
      currentRequestId: null  // 当前任务的 requestId
    };

    console.log('[Agent] 🚀 启动 claude-driver PTY...');

    driver.ptyProc = pty.spawn(CLAUDE_CMD, CLAUDE_ARGS, {
      name: 'xterm-color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    driver.ptyProc.onExit(({ exitCode }) => {
      console.log(`[Agent] PTY 退出 (code: ${exitCode})`);
      if (this._agentDriver === driver) {
        this._agentDriver = null;
        // 如果有等待中的任务，报错
        if (driver.taskRejectFn) {
          driver.taskRejectFn(new Error('Claude PTY 意外退出'));
          driver.taskResolveFn = null;
          driver.taskRejectFn = null;
        }
      }
    });

    driver.ptyProc.onData((raw) => {
      driver.canvas.write(raw);

      // WAITING_FOR_BUSY 阶段：检测 esc to interrupt
      if (driver.state === 'WAITING_FOR_BUSY') {
        const visualText = driver.canvas.getVisualText();
        if (ClaudeOutputParser.isBusy(visualText)) {
          driver.state = 'BUSY';
          console.log('[Agent] 侦测到 BUSY 状态');
          // 转发进度事件给 SSE
          this._send({ type: 'agent_stream', event: { type: 'status', state: 'busy' } });
        }
      }

      // 防抖
      clearTimeout(driver.idleTimer);
      const dtime = driver.state === 'STARTING' ? STARTING_DEBOUNCE_MS : IDLE_DEBOUNCE_MS;
      driver.idleTimer = setTimeout(() => this._onAgentIdleDetected(driver), dtime);
    });

    this._agentDriver = driver;
    console.log('[Agent] ✅ claude-driver PTY 已启动，等待 IDLE...');
  }

  // 空闲检测回调
  _onAgentIdleDetected(driver) {
    if (this._agentDriver !== driver) return;
    const visualText = driver.canvas.getVisualText();

    // 权限请求检测（仅在执行中）— 返回给 OpenClaw 决策，不自动放行
    if ((driver.state === 'BUSY' || driver.state === 'WAITING_FOR_BUSY') &&
        ClaudeOutputParser.isPermissionRequest(visualText)) {
      if (driver.state === '_PERMISSION') return;
      driver.state = '_PERMISSION';

      // 提取权限提示文本
      const rawLines = visualText.split('\n');
      const cleanLines = rawLines.filter(line => {
        const t = line.trim();
        if (!t) return false;
        if ((t.match(/[─╌━]/g) || []).length > 10) return false;
        if (/^[▘▝▖▗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻◐◑◒◓·]+/.test(t)) return false;
        if (t === '❯') return false;
        return true;
      }).slice(-10);
      const prompt = cleanLines.join('\n');

      console.log(`[Agent] ⚠️ 检测到权限请求，等待 OpenClaw 决策...`);

      // 返回 permission_request 给 relay-server → OpenClaw
      this._send({
        type: 'agent_result',
        requestId: driver.currentRequestId,
        status: 'permission_request',
        prompt
      });
      return;
    }

    if (driver.state === 'STARTING') {
      driver.state = 'IDLE';
      console.log('[Agent] ✅ Claude 已就绪 (IDLE)');
      // 将冷启动完成的就绪状态同步给中继，让 OpenClaw 的 SSE 感知到
      this._send({ type: 'agent_stream', event: { type: 'status', state: 'idle' } });
      return;
    }

    if (driver.state === 'BUSY') {
      if (ClaudeOutputParser.isDone(visualText)) {
        driver.state = 'IDLE';
        const replyText = ClaudeOutputParser.extractResponse(visualText);
        console.log(`[Agent] 📦 任务完成，回复 ${replyText.length} 字符`);

        if (driver.taskResolveFn) {
          clearTimeout(driver.taskTimer);
          const fn = driver.taskResolveFn;
          driver.taskResolveFn = null;
          driver.taskRejectFn = null;
          fn(replyText);
        }
      }
    }
  }

  // 处理来自中继的 Agent 任务（PTY 模式）
  _handleAgentQuery(msg) {
    const { requestId, message } = msg;
    const driver = this._agentDriver;

    if (!driver || !driver.ptyProc) {
      this._send({
        type: 'agent_result',
        requestId,
        reply: '[ERROR] claude-driver 未启动，请先调用 agent_start'
      });
      return;
    }

    if (driver.state !== 'IDLE') {
      this._send({
        type: 'agent_result',
        requestId,
        reply: `[ERROR] claude-driver 不在空闲状态，当前: ${driver.state}`
      });
      return;
    }

    console.log(`[Agent] 📤 发送消息: ${message.substring(0, 80)}...`);

    // 重置画布，准备新一轮
    driver.canvas = new ClaudeTerminalCanvas(220, 3000);
    driver.state = 'WAITING_FOR_BUSY';
    driver.currentRequestId = requestId;

    // 设置超时
    driver.taskTimer = setTimeout(() => {
      driver.taskResolveFn = null;
      driver.taskRejectFn = null;
      driver.state = 'IDLE';
      this._send({
        type: 'agent_result',
        requestId,
        reply: '[ERROR] 执行超时 (600s)'
      });
    }, 600000);

    // 设置回调
    driver.taskResolveFn = (replyText) => {
      this._send({
        type: 'agent_result',
        requestId,
        reply: replyText
      });
    };
    driver.taskRejectFn = (err) => {
      this._send({
        type: 'agent_result',
        requestId,
        reply: `[ERROR] ${err.message}`
      });
    };

    // 写入消息到 PTY
    driver.ptyProc.write(message + '\r');
  }

  // 处理 OpenClaw 的权限决策
  _handleAgentPermission(msg) {
    const driver = this._agentDriver;
    if (!driver || driver.state !== '_PERMISSION') {
      console.log('[Agent] ⚠️ 收到 permission 但状态不匹配，忽略');
      return;
    }

    if (msg.allow) {
      console.log('[Agent] ✅ OpenClaw 批准权限，发送回车确认');
      driver.state = 'BUSY';
      driver.canvas = new ClaudeTerminalCanvas(220, 3000);
      driver.ptyProc.write('\r');
    } else {
      console.log('[Agent] ❌ OpenClaw 拒绝权限，发送 Escape 取消');
      driver.state = 'BUSY';
      driver.canvas = new ClaudeTerminalCanvas(220, 3000);
      driver.ptyProc.write('\x1b');  // Escape 键
    }
  }

  // 停止 claude-driver PTY
  _handleAgentStop() {
    if (this._agentDriver) {
      console.log('[Agent] 🛑 停止 claude-driver PTY');
      clearTimeout(this._agentDriver.idleTimer);
      clearTimeout(this._agentDriver.taskTimer);
      try { this._agentDriver.ptyProc.kill(); } catch {}
      this._agentDriver = null;
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
    this._handleAgentStop();
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();

    this.sessionManager.off('output', this._onOutput);
    this.sessionManager.off('created', this._onCreated);
    this.sessionManager.off('closed', this._onClosed);
    this.sessionManager.off('exit', this._onExit);
  }
}

module.exports = RelayClient;
