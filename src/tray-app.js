const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const SysTray = require('systray2').default;
let open;
import('open').then(m => open = m.default);

const SessionManager = require('./session-manager');
const RelayClient = require('./relay-client');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

class TrayApp {
  constructor() {
    this.sessionManager = new SessionManager();
    this.relayClient = null;
    this.systray = null;
    this.httpServer = null;

    // 持久化设置，包含 token
    this.settings = { relayHost: '', token: null };
    this.pairCode = '';
    
    this.menuReady = false;
    this.connStatus = '未连接';
    this.lastError = null;
    
    // SSE 客户端列表（用于实时推送状态到 9899 页面）
    this.sseClients = new Set();

    this.loadSettings();
    this.generatePairCode();
  }

  loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        this.settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      } catch (e) {}
    }
  }

  saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
  }

  generatePairCode() {
    this.pairCode = crypto.randomInt(100000, 999999).toString();
    this.updateTray();
    this.pushStatus();
  }

  async startSystray() {
    this.icon = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABHklEQVRYR+2WwQ3CMAxFnwQGgDFoRmED2rAAI7CBdJQZgA1oQxqGYYkDE0yQKtJSo05Q4i9Vihzbd+/5r0l0G/O78tOamANcEWAJ2INfOwc4/RbgGvgG5v/hX4Kig3fAa/8eYAX4lY6zAmx/bYClK21gXQEeHQRvDthWpA+cOwBv3hK8Bdx1AG98I3gHqF0GqPEb2a4A1B2gXAEVwP0yQMWVAKoA6hWg4p4GqAqoV4CKexqgKqBeASruaYCqgHoFqLinAaoCqk8A1d1aE6DuYVUB/LzKAlDdzTMB6p6aCeCVRgrwdhUlwNtVdIKk1gZ2yT3XyQ3XzZ6D5B4cW1fR129Gq6vp+Qp2J2sQ4tW7QogAAAAASUVORK5CYII=';

    this.systray = new SysTray({
      menu: {
        icon: this.icon,
        title: "CloudHand",
        tooltip: "CloudHand Mini-Term",
        items: this.buildMenuItems()
      },
      debug: false,
      copyDir: true
    });

    this.systray.onClick(action => {
      if (action.seq_id === 0) {
        // [状态] 不可点击
      } else if (action.seq_id === 1) {
        // 打开设置
        if (open) open('http://127.0.0.1:9899');
      } else if (action.seq_id === 2) {
        // 退出
        this.systray.kill();
        process.exit(0);
      }
    });

    await this.systray.ready();
    this.menuReady = true;
    this.updateTray();
  }

  buildMenuItems() {
    return [
      {
        title: `状态: ${this.connStatus} (${this.settings.relayHost || '未配置服务器'})`,
        tooltip: "状态",
        checked: false,
        enabled: false,
      },
      {
        title: "⚙️ 打开设置",
        tooltip: "配置并连接",
        checked: false,
        enabled: true,
      },
      {
        title: "❌ 退出",
        tooltip: "Exit",
        checked: false,
        enabled: true,
      }
    ];
  }

  updateTray() {
    if (!this.menuReady || !this.systray) return;
    // 用 update-item 更新状态菜单项（比 update-menu 更可靠）
    this.systray.sendAction({
      type: 'update-item',
      item: {
        title: `状态: ${this.connStatus} (${this.settings.relayHost || '未配置服务器'})`,
        tooltip: "状态",
        checked: false,
        enabled: false,
      },
      seq_id: 0
    });
  }

  setConnStatus(status, error) {
    if (this.connStatus !== status || this.lastError !== (error || null)) {
      this.connStatus = status;
      this.lastError = error || null;
      this.updateTray();
      this.pushStatus();
    }
  }

  // 推送状态给所有 SSE 客户端
  pushStatus() {
    const data = JSON.stringify(this.getStatusData());
    for (const res of this.sseClients) {
      try { res.write(`data: ${data}\n\n`); } catch {}
    }
  }

  getStatusData() {
    return {
      pairCode: this.pairCode,
      relayHost: this.settings.relayHost || '',
      connStatus: this.connStatus,
      hasToken: !!this.settings.token,
      token: this.settings.token, // 增加 token 返回
      error: this.lastError
    };
  }

  startHttpServer() {
    this.httpServer = http.createServer((req, res) => {
      const urlObj = new URL(req.url, 'http://127.0.0.1:9899');

      // 主页 — 设置与连接界面
      if (req.method === 'GET' && urlObj.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderSettingsPage());
        return;
      }

      // SSE 状态推送
      if (req.method === 'GET' && urlObj.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write(`data: ${JSON.stringify(this.getStatusData())}\n\n`);
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        return;
      }

      // API: 获取当前状态
      if (req.method === 'GET' && urlObj.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getStatusData()));
        return;
      }

      // API: 保存设置 + 手动触发连接
      if (req.method === 'POST' && urlObj.pathname === '/connect') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.host !== undefined) {
              this.settings.relayHost = data.host.trim();
              this.saveSettings();
            }
            this.connectRelay(false); // 首次配对模式
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // API: 刷新配对码
      if (req.method === 'POST' && urlObj.pathname === '/refresh-code') {
        this.generatePairCode();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pairCode: this.pairCode }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.httpServer.listen(9899, '127.0.0.1', () => {
      console.log('[本机控制器] 监听于 http://127.0.0.1:9899');
    });
  }

  // 连接中继（autoMode=true 使用 token 静默连接，false 使用配对码首次连接）
  connectRelay(autoMode) {
    if (this.relayClient) {
      this.relayClient.destroy();
      this.relayClient = null;
    }

    if (!this.settings.relayHost) {
      this.setConnStatus('尚未配置服务器地址');
      return;
    }

    this.setConnStatus('正在连接中继...');

    this.relayClient = new RelayClient({
      relayHost: this.settings.relayHost,
      pairCode: autoMode ? null : this.pairCode,
      token: autoMode ? this.settings.token : null,
      sessionManager: this.sessionManager
    });

    // 监听事件
    this.relayClient.on('connected', () => {
      this.setConnStatus('握手中...');
    });

    this.relayClient.on('authenticated', ({ token, isNewToken }) => {
      if (isNewToken && token) {
        // 首次配对成功：先持久化 token，再触发 pushStatus，确保前端拿到最新 token
        this.settings.token = token;
        this.saveSettings();
      }

      // token 写入之后再 setConnStatus（内部触发 pushStatus 推送给前端）
      this.setConnStatus('🟢 已连通 (就绪)');
    });

    this.relayClient.on('auth_failed', ({ reason }) => {
      this.setConnStatus('🔴 验证失败', reason);
    });

    this.relayClient.on('token_expired', () => {
      // token 过期，清除持久化的 token
      this.settings.token = null;
      this.saveSettings();
      this.setConnStatus('🔴 Token 已过期，需要重新配对');
    });

    this.relayClient.on('disconnected', () => {
      if (this.relayClient && this.relayClient.token) {
        this.setConnStatus('⏳ 断线重连中...');
      } else {
        this.setConnStatus('❌ 已断开');
      }
    });

    this.relayClient.connect();
  }

  // 打开远程终端 UI 页面
  openRemoteUI(token) {
    if (!this.settings.relayHost || !token || !open) return;

    let host = this.settings.relayHost;
    // 判断协议
    let url;
    if (host.startsWith('http://') || host.startsWith('https://')) {
      url = `${host}/?token=${token}`;
    } else {
      url = `http://${host}/?token=${token}`;
    }

    console.log(`[本机控制器] 打开远程 UI: ${url}`);
    open(url);
  }

  renderSettingsPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CloudHand 终端桥接设置</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0d1117; --bg-card: #161b22; --bg-input: #010409;
      --border: #30363d; --border-focus: #58a6ff;
      --text: #e6edf3; --text-dim: #8b949e; --text-muted: #6e7681;
      --accent: #58a6ff; --accent-dim: rgba(88,166,255,0.15);
      --green: #3fb950; --green-dim: rgba(63,185,80,0.15); --green-glow: rgba(63,185,80,0.3);
      --red: #f85149; --red-dim: rgba(248,81,73,0.15);
      --yellow: #d29922; --yellow-dim: rgba(210,153,34,0.15);
      --font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg); color: var(--text); font-family: var(--font);
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 16px; padding: 32px; width: 100%; max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    .header { text-align: center; margin-bottom: 28px; }
    .header-icon { font-size: 36px; margin-bottom: 8px; }
    .header h1 {
      font-size: 20px; font-weight: 700;
      background: linear-gradient(135deg, #58a6ff, #3fb950);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .header p { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    /* 状态指示器 */
    .status-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; border-radius: 8px; margin-bottom: 20px;
      font-size: 13px; font-weight: 500;
      background: var(--bg); border: 1px solid var(--border);
      transition: all 0.3s;
    }
    .status-bar.connected { background: var(--green-dim); border-color: var(--green-glow); color: var(--green); }
    .status-bar.error { background: var(--red-dim); border-color: rgba(248,81,73,0.3); color: var(--red); }
    .status-bar.warning { background: var(--yellow-dim); border-color: rgba(210,153,34,0.3); color: var(--yellow); }
    .status-bar.connecting { background: var(--accent-dim); border-color: rgba(88,166,255,0.3); color: var(--accent); }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: currentColor; transition: all 0.3s;
    }
    .status-bar.connecting .status-dot { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

    /* 表单元素 */
    label { display: block; font-size: 12px; color: var(--text-dim); margin: 16px 0 6px; font-weight: 500; letter-spacing: 0.3px; }
    input[type="text"] {
      width: 100%; padding: 10px 12px; background: var(--bg-input); border: 1px solid var(--border);
      color: var(--text); border-radius: 8px; font-size: 14px; font-family: var(--font);
      outline: none; transition: border-color 0.2s;
    }
    input[type="text"]:focus { border-color: var(--border-focus); }

    /* 配对码展示 */
    .code-section { margin: 16px 0; }
    .code-row { display: flex; align-items: center; gap: 8px; }
    .code-box {
      flex: 1; font-size: 22px; padding: 12px; text-align: center;
      letter-spacing: 6px; background: var(--bg-input);
      border: 1px dashed var(--accent); border-radius: 8px;
      color: var(--accent); font-weight: 700;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      user-select: all; cursor: pointer;
      transition: all 0.2s;
    }
    .code-box:hover { background: var(--accent-dim); }
    .code-box:active { transform: scale(0.98); }
    .btn-icon {
      padding: 10px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text-dim); cursor: pointer;
      font-size: 16px; transition: all 0.2s; line-height: 1;
    }
    .btn-icon:hover { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
    .tip { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.4; }

    /* 按钮 */
    .btn-primary {
      margin-top: 20px; width: 100%; padding: 12px;
      background: linear-gradient(135deg, #238636, #2ea043);
      color: #fff; border: none; border-radius: 8px;
      cursor: pointer; font-size: 14px; font-weight: 600;
      font-family: var(--font); transition: all 0.2s;
      position: relative; overflow: hidden;
    }
    .btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(35,134,54,0.4); }
    .btn-primary:active { transform: translateY(0); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; filter: none; box-shadow: none; }

    .btn-secondary {
      margin-top: 12px; width: 100%; padding: 12px;
      background: linear-gradient(135deg, #0969da, #0550ae);
      color: #fff; border: none; border-radius: 8px;
      cursor: pointer; font-size: 14px; font-weight: 600;
      font-family: var(--font); transition: all 0.2s;
      display: none; /* 初始隐藏 */
      text-align: center; text-decoration: none;
    }
    .btn-secondary:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(9,105,218,0.4); }

    /* 错误消息 */
    .error-msg {
      margin-top: 12px; padding: 10px 14px; border-radius: 8px;
      background: var(--red-dim); border: 1px solid rgba(248,81,73,0.2);
      color: var(--red); font-size: 12px; display: none;
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

    /* Token 提示 */
    .token-hint {
      margin-top: 12px; padding: 8px 12px; border-radius: 8px;
      background: var(--green-dim); border: 1px solid rgba(63,185,80,0.2);
      color: var(--green); font-size: 11px; display: none;
    }

    .divider { height: 1px; background: var(--border); margin: 20px 0; }
    .footer { text-align: center; font-size: 10px; color: var(--text-muted); margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="header-icon">☁️</div>
      <h1>CloudHand 终端桥接</h1>
      <p>配置远程中继并建立安全连接</p>
    </div>

    <!-- 状态指示器 -->
    <div class="status-bar" id="statusBar">
      <span class="status-dot"></span>
      <span id="statusText">检查中...</span>
    </div>

    <!-- 中继地址 -->
    <label>远程中继主机地址</label>
    <input type="text" id="hostInput" placeholder="例: opc.dabeizi.com:3456 或 https://relay.example.com" />

    <!-- 配对码 -->
    <div class="code-section">
      <label>本机配对码（点击即可复制）</label>
      <div class="code-row">
        <div class="code-box" id="codeBox" title="点击复制"></div>
        <button class="btn-icon" id="refreshBtn" title="刷新配对码">🔄</button>
      </div>
      <div class="tip">将此 6 位数告诉 OpenClaw，让它设置到中继服务器上，然后点击下方连接按钮</div>
    </div>

    <div id="tokenHint" class="token-hint">✅ 已有有效 Token，启动时将自动连接</div>

    <!-- 连接按钮 -->
    <button class="btn-primary" id="connectBtn">🔗 连接到中继服务器</button>
    
    <!-- 访问按钮 -->
    <button class="btn-secondary" id="openRemoteBtn">🚀 访问并复制远程终端地址</button>
    <div id="urlDisplay" style="margin-top:8px;padding:8px 12px;border-radius:8px;background:#010409;border:1px solid #30363d;color:#8b949e;font-size:11px;word-break:break-all;display:none;"></div>

    <div class="error-msg" id="errorMsg"></div>

    <div class="footer">连接成功后将自动打开远程终端页面</div>
  </div>

  <script>
  (function() {
    const hostInput = document.getElementById('hostInput');
    const codeBox = document.getElementById('codeBox');
    const refreshBtn = document.getElementById('refreshBtn');
    const connectBtn = document.getElementById('connectBtn');
    const openRemoteBtn = document.getElementById('openRemoteBtn');
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');
    const errorMsg = document.getElementById('errorMsg');
    const tokenHint = document.getElementById('tokenHint');
    const urlDisplay = document.getElementById('urlDisplay');

    let connecting = false;
    let remoteUrl = '';

    // SSE 实时状态
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      updateUI(data);
    };

    function updateUI(data) {
      codeBox.textContent = data.pairCode || '------';
      if (!hostInput.value && data.relayHost) hostInput.value = data.relayHost;

      tokenHint.style.display = data.hasToken ? 'block' : 'none';

      // 状态样式
      statusBar.className = 'status-bar';
      const isConnected = data.connStatus.includes('已连通') || data.connStatus.includes('就绪');
      
      if (isConnected) {
        statusBar.classList.add('connected');
        // 构造远程 URL
        let host = data.relayHost;
        if (host) {
          const protocol = (host.startsWith('http://') || host.startsWith('https://')) ? '' : 'http://';
          remoteUrl = protocol + host + "/?token=" + data.token;
          openRemoteBtn.style.display = 'block';
          urlDisplay.style.display = 'block';
          urlDisplay.textContent = '链接: ' + remoteUrl + ' | token原始值: [' + data.token + ']';
        }
      } else if (data.connStatus.includes('失败') || data.connStatus.includes('过期') || data.connStatus.includes('断开')) {
        statusBar.classList.add('error');
        openRemoteBtn.style.display = 'none';
      } else if (data.connStatus.includes('连接') || data.connStatus.includes('握手') || data.connStatus.includes('重连')) {
        statusBar.classList.add('connecting');
      }
      statusText.textContent = data.connStatus;

      // 错误信息
      if (data.error) {
        errorMsg.textContent = '❌ ' + data.error;
        errorMsg.style.display = 'block';
      } else {
        errorMsg.style.display = 'none';
      }

      // 连接成功后恢复按钮
      if (isConnected) {
        connecting = false;
        connectBtn.disabled = false;
        connectBtn.textContent = '✅ 已连通';
      }
    }

    // 复制配对码
    codeBox.addEventListener('click', () => {
      const code = codeBox.textContent;
      navigator.clipboard.writeText(code).then(() => {
        const original = codeBox.style.borderColor;
        codeBox.style.borderColor = '#3fb950';
        setTimeout(() => { codeBox.style.borderColor = ''; }, 600);
      });
    });

    // 访问并复制按钮
    openRemoteBtn.addEventListener('click', () => {
      if (!remoteUrl) return;
      // 复制到剪贴板
      navigator.clipboard.writeText(remoteUrl).then(() => {
        const originalText = openRemoteBtn.textContent;
        openRemoteBtn.textContent = '✅ 已复制到剪贴板并打开...';
        setTimeout(() => { openRemoteBtn.textContent = originalText; }, 2000);
      });
      // 打开窗口
      window.open(remoteUrl, '_blank');
    });

    // 刷新配对码
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      await fetch('/refresh-code', { method: 'POST' });
      setTimeout(() => { refreshBtn.disabled = false; }, 1000);
    });

    // 连接按钮（防重复点击）
    connectBtn.addEventListener('click', async () => {
      if (connecting) return;
      const host = hostInput.value.trim();
      if (!host) {
        errorMsg.textContent = '❌ 请先填写中继主机地址';
        errorMsg.style.display = 'block';
        return;
      }
      connecting = true;
      connectBtn.disabled = true;
      connectBtn.textContent = '⏳ 正在连接中...';
      errorMsg.style.display = 'none';

      try {
        await fetch('/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host })
        });
        // 状态会通过 SSE 推送更新
        // 设置超时恢复按钮
        setTimeout(() => {
          if (connecting) {
            connecting = false;
            connectBtn.disabled = false;
            connectBtn.textContent = '🔗 重新连接';
          }
        }, 15000);
      } catch (e) {
        connecting = false;
        connectBtn.disabled = false;
        connectBtn.textContent = '🔗 连接到中继服务器';
        errorMsg.textContent = '❌ 请求失败: ' + e.message;
        errorMsg.style.display = 'block';
      }
    });
  })();
  </script>
</body>
</html>`;
  }

  async run() {
    await this.startSystray();
    this.startHttpServer();

    // 启动后自动打开设置页面
    setTimeout(() => {
      if (open) open('http://127.0.0.1:9899');
    }, 500);

    // 智能连接策略：有 token 则自动用 token 静默连接
    if (this.settings.token && this.settings.relayHost) {
      console.log('[本机控制器] 检测到存储的 token，自动连接中继...');
      this.connectRelay(true); // true = 使用 token 自动模式
    } else {
      console.log('[本机控制器] 无 token，等待用户在设置页面手动配对');
    }
  }
}

const app = new TrayApp();
app.run();
