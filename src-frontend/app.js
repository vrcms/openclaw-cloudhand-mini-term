import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// CloudHand Mini-Term 前端应用
class CloudHandTerminal {
  constructor() {
    this.ws = null;
    this.sessions = new Map();
    this.activeSessionId = null;
    this.pairCode = '------';
    this.pairCodeExpiry = null;
    this.timerInterval = null;

    // DOM 引用
    this.sessionListEl = document.getElementById('sessionList');
    this.terminalWrapper = document.getElementById('terminal-wrapper');
    this.terminalPlaceholder = document.getElementById('terminal-placeholder');
    this.pairCodeEl = document.getElementById('pairCode');
    this.pairTimerEl = document.getElementById('pairTimer');
    this.newSessionBtn = document.getElementById('newSessionBtn');
    this.remoteStatusEl = document.getElementById('remoteStatus');

    this.init();
  }

  init() {
    this.connectWs();
    this.bindEvents();
    this.startCountdown();
  }

  // 连接本地 WS 服务
  connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${protocol}://${location.host}`);

    this.ws.onopen = () => console.log('[WS] 已连接');

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      console.log('[WS] 断开，3秒后重连...');
      setTimeout(() => this.connectWs(), 3000);
    };

    this.ws.onerror = () => {};
  }

  bindEvents() {
    // 新建会话按钮
    this.newSessionBtn.addEventListener('click', () => {
      this.createSession();
    });

    // 窗口尺寸变化时 fit 终端
    window.addEventListener('resize', () => {
      if (this.activeSessionId) {
        const s = this.sessions.get(this.activeSessionId);
        if (s && s.fitAddon) s.fitAddon.fit();
      }
    });
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'pair_code':
        this.pairCode = msg.pairCode;
        this.pairCodeExpiry = msg.expiresAt;
        this.updatePairCodeDisplay();
        break;

      case 'session_list':
        for (const s of msg.sessions) {
          if (!this.sessions.has(s.id)) this.addSession(s);
        }
        this.renderSessionList();
        if (msg.sessions.length > 0 && !this.activeSessionId) {
          this.switchToSession(msg.sessions[0].id);
        }
        break;

      case 'session_created':
        if (!this.sessions.has(msg.sessionId)) {
          this.addSession({
            id: msg.sessionId,
            cwd: msg.cwd,
            shell: msg.shell,
            createdAt: msg.createdAt
          });
        }
        this.renderSessionList();
        this.switchToSession(msg.sessionId);
        break;

      case 'output': {
        const s = this.sessions.get(msg.sessionId);
        if (s && s.terminal) {
          s.terminal.write(msg.data);
        }
        break;
      }

      case 'session_closed':
      case 'session_exit':
        this.removeSession(msg.sessionId);
        break;

      case 'remote_connected':
        this.updateRemoteStatus(true);
        break;

      case 'remote_disconnected':
        this.updateRemoteStatus(false);
        break;

      case 'error':
        console.error('[服务端]', msg.message);
        break;
    }
  }

  // 添加会话（创建 xterm 实例）
  addSession(info) {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc'
      }
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // 创建终端 DOM 容器
    const termDiv = document.createElement('div');
    termDiv.className = 'terminal-instance hidden';
    termDiv.id = `term-${info.id}`;
    this.terminalWrapper.appendChild(termDiv);

    terminal.open(termDiv);

    // 终端输入 → 发送到服务端
    terminal.onData((data) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'input',
          sessionId: info.id,
          data
        }));
      }
    });

    // 终端尺寸变化 → 通知服务端
    terminal.onResize(({ cols, rows }) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'resize',
          sessionId: info.id,
          cols,
          rows
        }));
      }
    });

    this.sessions.set(info.id, {
      ...info,
      terminal,
      fitAddon,
      termDiv
    });
  }

  // 移除会话
  removeSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.terminal.dispose();
      s.termDiv.remove();
      this.sessions.delete(sessionId);
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      const remaining = Array.from(this.sessions.keys());
      if (remaining.length > 0) {
        this.switchToSession(remaining[0]);
      } else {
        this.terminalPlaceholder.classList.remove('hidden');
      }
    }
    this.renderSessionList();
  }

  // 切换到指定会话
  switchToSession(sessionId) {
    // 隐藏当前
    if (this.activeSessionId) {
      const old = this.sessions.get(this.activeSessionId);
      if (old) old.termDiv.classList.add('hidden');
    }

    const s = this.sessions.get(sessionId);
    if (s) {
      this.terminalPlaceholder.classList.add('hidden');
      s.termDiv.classList.remove('hidden');
      s.fitAddon.fit();
      s.terminal.focus();
      this.activeSessionId = sessionId;
    }
    this.renderSessionList();
  }

  // 创建新会话
  createSession(cwd) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'create_session',
        cwd: cwd || undefined
      }));
    }
  }

  // 渲染会话列表
  renderSessionList() {
    this.sessionListEl.innerHTML = '';
    for (const [id, session] of this.sessions) {
      const item = document.createElement('div');
      item.className = `session-item ${id === this.activeSessionId ? 'active' : ''}`;
      // 显示简短路径
      const shortCwd = session.cwd
        ? session.cwd.replace(/^.*[/\\]/, '') || session.cwd
        : '~';
      item.innerHTML = `
        <div class="session-info">
          <span class="session-name">● ${session.shell || 'shell'}</span>
          <span class="session-cwd">${shortCwd}</span>
        </div>
        <button class="session-close" data-id="${id}" title="关闭会话">×</button>
      `;
      item.addEventListener('click', (e) => {
        if (!e.target.classList.contains('session-close')) {
          this.switchToSession(id);
        }
      });
      item.querySelector('.session-close').addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeSession(id);
      });
      this.sessionListEl.appendChild(item);
    }
  }

  // 关闭会话
  closeSession(sessionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'close_session',
        sessionId
      }));
    }
  }

  // 更新配对码显示
  updatePairCodeDisplay() {
    this.pairCodeEl.textContent = this.pairCode;
  }

  // 倒计时刷新
  startCountdown() {
    this.timerInterval = setInterval(() => {
      if (!this.pairCodeExpiry) return;
      const remaining = Math.max(0, this.pairCodeExpiry - Date.now());
      const min = Math.floor(remaining / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      this.pairTimerEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    }, 1000);
  }

  // 更新远程连接状态
  updateRemoteStatus(connected) {
    if (this.remoteStatusEl) {
      if (connected) {
        this.remoteStatusEl.classList.add('connected');
        this.remoteStatusEl.querySelector('.status-text').textContent = '远程已连接';
      } else {
        this.remoteStatusEl.classList.remove('connected');
        this.remoteStatusEl.querySelector('.status-text').textContent = '等待连接';
      }
    }
  }
}

// 启动
document.addEventListener('DOMContentLoaded', () => {
  new CloudHandTerminal();
});
