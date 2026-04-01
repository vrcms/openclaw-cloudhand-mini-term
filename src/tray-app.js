const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
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

    // 持久化设置
    this.settings = { relayHost: '', token: null, computer_name: '' };
    
    this.menuReady = false;
    this.connStatus = '未连接';
    this.lastError = null;
    
    // SSE 客户端列表（用于实时推送状态到 9899 页面）
    this.sseClients = new Set();

    this.loadSettings();
    this.ensureTokenAndName();
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

  // 确保有 Token 和 computer_name（首次启动自动生成）
  ensureTokenAndName() {
    let changed = false;

    if (!this.settings.token) {
      this.settings.token = crypto.randomUUID();
      console.log(`[本机控制器] 🔑 已生成新 Token: ${this.settings.token}`);
      changed = true;
    }

    if (!this.settings.computer_name) {
      this.settings.computer_name = os.hostname();
      console.log(`[本机控制器] 💻 电脑名称默认为: ${this.settings.computer_name}`);
      changed = true;
    }

    if (changed) this.saveSettings();
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
      relayHost: this.settings.relayHost || '',
      connStatus: this.connStatus,
      token: this.settings.token,
      computer_name: this.settings.computer_name,
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

      // API: 保存设置 + 触发连接
      if (req.method === 'POST' && urlObj.pathname === '/connect') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            let changed = false;
            if (data.host !== undefined) {
              this.settings.relayHost = data.host.trim();
              changed = true;
            }
            if (data.computer_name !== undefined && data.computer_name.trim()) {
              this.settings.computer_name = data.computer_name.trim();
              changed = true;
            }
            if (changed) this.saveSettings();
            this.connectRelay();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // API: 刷新 Token（重新生成 UUID）
      if (req.method === 'POST' && urlObj.pathname === '/refresh-token') {
        this.settings.token = crypto.randomUUID();
        this.saveSettings();
        console.log(`[本机控制器] 🔑 Token 已刷新: ${this.settings.token}`);
        // 如果正在连接中，断开旧连接
        if (this.relayClient) {
          this.relayClient.destroy();
          this.relayClient = null;
          this.setConnStatus('⚠️ Token 已更换，请重新连接');
        }
        this.pushStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: this.settings.token }));
        return;
      }

      // API: 断开连接（停止重连）
      if (req.method === 'POST' && urlObj.pathname === '/disconnect') {
        if (this.relayClient) {
          this.relayClient.destroy();
          this.relayClient = null;
        }
        this.setConnStatus('❌ 已手动断开');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.httpServer.listen(9899, '127.0.0.1', () => {
      console.log('[本机控制器] 监听于 http://127.0.0.1:9899');
    });
  }

  // 连接中继（始终使用持久化 Token）
  connectRelay() {
    if (this.relayClient) {
      this.relayClient.destroy();
      this.relayClient = null;
    }

    if (!this.settings.relayHost) {
      this.setConnStatus('尚未配置服务器地址');
      return;
    }

    if (!this.settings.token) {
      this.ensureTokenAndName();
    }

    this.setConnStatus('正在连接中继...');

    this.relayClient = new RelayClient({
      relayHost: this.settings.relayHost,
      token: this.settings.token,
      computerName: this.settings.computer_name,
      sessionManager: this.sessionManager
    });

    // 监听事件
    this.relayClient.on('connected', () => {
      this.setConnStatus('握手中...');
    });

    this.relayClient.on('authenticated', ({ computerName }) => {
      this.setConnStatus('🟢 已连通 (就绪)');
    });

    this.relayClient.on('auth_failed', ({ reason }) => {
      this.setConnStatus('🔴 验证失败', reason);
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
  openRemoteUI() {
    const token = this.settings.token;
    if (!this.settings.relayHost || !token || !open) return;

    let host = this.settings.relayHost;
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

    /* Token 展示 */
    .token-section { margin: 16px 0; }
    .token-row { display: flex; align-items: center; gap: 8px; }
    .token-box {
      flex: 1; font-size: 11px; padding: 10px 12px; text-align: center;
      background: var(--bg-input); border: 1px dashed var(--border);
      border-radius: 8px; color: var(--text-dim);
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      word-break: break-all; cursor: pointer; user-select: all;
      transition: all 0.2s;
    }
    .token-box:hover { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
    .btn-icon {
      padding: 10px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text-dim); cursor: pointer;
      font-size: 16px; transition: all 0.2s; line-height: 1; flex-shrink: 0;
    }
    .btn-icon:hover { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
    .btn-icon:disabled { opacity: 0.4; cursor: not-allowed; }
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

    .btn-danger {
      margin-top: 8px; width: 100%; padding: 12px;
      background: linear-gradient(135deg, #da3633, #b62324);
      color: #fff; border: none; border-radius: 8px;
      cursor: pointer; font-size: 14px; font-weight: 600;
      font-family: var(--font); transition: all 0.2s;
      display: none;
    }
    .btn-danger:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(218,54,51,0.4); }
    .btn-danger:active { transform: translateY(0); }

    .btn-secondary {
      margin-top: 12px; width: 100%; padding: 12px;
      background: linear-gradient(135deg, #0969da, #0550ae);
      color: #fff; border: none; border-radius: 8px;
      cursor: pointer; font-size: 14px; font-weight: 600;
      font-family: var(--font); transition: all 0.2s;
      display: none;
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

    <!-- 电脑名称 -->
    <label>电脑名称</label>
    <input type="text" id="nameInput" placeholder="例: 东哥的主力机" />

    <!-- 中继地址 -->
    <label>远程中继主机地址</label>
    <input type="text" id="hostInput" placeholder="例: opc.dabeizi.com:3456 或 https://relay.example.com" />

    <!-- Token 展示 -->
    <div class="token-section">
      <label>本机 Token（点击复制）</label>
      <div class="token-row">
        <div class="token-box" id="tokenBox" title="点击复制"></div>
        <button class="btn-icon" id="refreshTokenBtn" title="重新生成 Token">🔄</button>
      </div>
      <div class="tip">此 Token 是本机的身份凭证，刷新后需重新连接中继</div>
    </div>

    <!-- 连接按钮 -->
    <button class="btn-primary" id="connectBtn">🔗 连接到中继服务器</button>

    <!-- 断开/停止按钮 -->
    <button class="btn-danger" id="disconnectBtn">⏹ 断开连接</button>
    
    <!-- 访问按钮 -->
    <button class="btn-secondary" id="openRemoteBtn">🚀 在浏览器中打开远程终端</button>
    
    <!-- URL 展示，点击可复制 -->
    <div id="urlDisplay" title="点击复制完整链接" style="margin-top:12px;padding:12px;border-radius:8px;background:var(--bg-input);border:1px dashed var(--accent);color:var(--accent);font-size:12px;word-break:break-all;display:none;cursor:pointer;text-align:center;font-family:monospace;transition:all 0.2s;"></div>

    <div class="error-msg" id="errorMsg"></div>
  </div>

  <script>
  (function() {
    const nameInput = document.getElementById('nameInput');
    const hostInput = document.getElementById('hostInput');
    const tokenBox = document.getElementById('tokenBox');
    const refreshTokenBtn = document.getElementById('refreshTokenBtn');
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const openRemoteBtn = document.getElementById('openRemoteBtn');
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');
    const errorMsg = document.getElementById('errorMsg');
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
      tokenBox.textContent = data.token || '生成中...';
      if (!nameInput.value && data.computer_name) nameInput.value = data.computer_name;
      if (!hostInput.value && data.relayHost) hostInput.value = data.relayHost;

      // 状态样式
      statusBar.className = 'status-bar';
      const isConnected = data.connStatus.includes('已连通') || data.connStatus.includes('就绪');
      const isConnecting = data.connStatus.includes('连接') || data.connStatus.includes('握手') || data.connStatus.includes('重连');
      const isDisconnected = !isConnected && !isConnecting;
      
      if (isConnected) {
        statusBar.classList.add('connected');
        let host = data.relayHost;
        if (host && data.token) {
          const protocol = (host.startsWith('http://') || host.startsWith('https://')) ? '' : 'http://';
          remoteUrl = protocol + host + "/?token=" + data.token;
          openRemoteBtn.style.display = 'block';
          urlDisplay.style.display = 'block';
          urlDisplay.textContent = remoteUrl;
        }
      } else if (data.connStatus.includes('失败') || data.connStatus.includes('过期') || data.connStatus.includes('断开') || data.connStatus.includes('更换')) {
        statusBar.classList.add('error');
        openRemoteBtn.style.display = 'none';
        urlDisplay.style.display = 'none';
      } else if (isConnecting) {
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

      // 按钮状态联动
      if (isConnected) {
        // 已连通：显示断开按钮，连接按钮变为已连通
        connecting = false;
        connectBtn.disabled = false;
        connectBtn.textContent = '✅ 已连通';
        disconnectBtn.style.display = 'block';
        disconnectBtn.textContent = '⏹ 断开连接';
      } else if (isConnecting) {
        // 正在连接/重连中：显示停止按钮
        connectBtn.disabled = true;
        connectBtn.textContent = '⏳ 正在连接中...';
        disconnectBtn.style.display = 'block';
        disconnectBtn.textContent = '⏹ 停止连接';
        openRemoteBtn.style.display = 'none';
        urlDisplay.style.display = 'none';
      } else {
        // 未连接：隐藏断开按钮，显示连接按钮
        connecting = false;
        connectBtn.disabled = false;
        connectBtn.textContent = '🔗 连接到中继服务器';
        disconnectBtn.style.display = 'none';
        openRemoteBtn.style.display = 'none';
        urlDisplay.style.display = 'none';
      }
    }

    // 复制 Token
    tokenBox.addEventListener('click', () => {
      const text = tokenBox.textContent;
      navigator.clipboard.writeText(text).then(() => {
        tokenBox.style.borderColor = '#3fb950';
        tokenBox.style.color = '#3fb950';
        setTimeout(() => { tokenBox.style.borderColor = ''; tokenBox.style.color = ''; }, 600);
      });
    });

    // 刷新 Token
    refreshTokenBtn.addEventListener('click', async () => {
      if (!confirm('刷新 Token 后需要重新连接中继，确定吗？')) return;
      refreshTokenBtn.disabled = true;
      try {
        await fetch('/refresh-token', { method: 'POST' });
      } catch (e) {
        errorMsg.textContent = '❌ 刷新失败: ' + e.message;
        errorMsg.style.display = 'block';
      }
      setTimeout(() => { refreshTokenBtn.disabled = false; }, 1000);
    });

    // 断开/停止按钮
    disconnectBtn.addEventListener('click', async () => {
      disconnectBtn.disabled = true;
      try {
        await fetch('/disconnect', { method: 'POST' });
      } catch (e) {
        errorMsg.textContent = '❌ 操作失败: ' + e.message;
        errorMsg.style.display = 'block';
      }
      disconnectBtn.disabled = false;
    });

    // 访问远程终端按钮
    openRemoteBtn.addEventListener('click', () => {
      if (!remoteUrl) return;
      window.open(remoteUrl, '_blank');
    });

    // 点击 URL 复制
    urlDisplay.addEventListener('click', () => {
      if (!remoteUrl) return;
      navigator.clipboard.writeText(remoteUrl).then(() => {
        const originalText = urlDisplay.textContent;
        urlDisplay.textContent = '✅ 已复制到剪贴板！';
        urlDisplay.style.background = 'var(--green-dim)';
        urlDisplay.style.borderColor = 'var(--green-glow)';
        urlDisplay.style.color = 'var(--green)';
        setTimeout(() => { 
          urlDisplay.textContent = originalText; 
          urlDisplay.style.background = '';
          urlDisplay.style.borderColor = '';
          urlDisplay.style.color = '';
        }, 1500);
      });
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
          body: JSON.stringify({ host, computer_name: nameInput.value.trim() })
        });
        // 状态会通过 SSE 推送更新，按钮通过 updateUI 联动
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

    // 有 Token 且有中继地址则自动连接
    if (this.settings.token && this.settings.relayHost) {
      console.log(`[本机控制器] 自动连接中继 (${this.settings.computer_name})...`);
      this.connectRelay();
    } else {
      console.log('[本机控制器] 等待用户在设置页面配置中继地址');
    }
  }
}

const app = new TrayApp();
app.run();
