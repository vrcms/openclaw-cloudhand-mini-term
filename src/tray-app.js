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

    this.settings = { relayHost: 'localhost:3456' };
    this.pairCode = '123456';
    
    this.menuReady = false;
    this.connStatus = '未连接';
    
    this.loadSettings();
    this.generatePairCode();
    
    // 5 分钟重新生成一次配对码
    setInterval(() => this.generatePairCode(), 300 * 1000);
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
    
    // 如果配置好了中继服务端，尝试更新服务端或重连。
    // 在现在的模型下，本地更换 pairCode 意味着它如果未连接，它就在后台尝试连接（如果之前断开的话）
    // 但原版 RelayClient 需要主动传入 pairCode 作为凭证去连接。
    // 我们是否应该重新连接？如果它目前是连接断开状态，重新连（带上新 pairCode 可能会被拒绝，直到用户告诉 OpenClaw 去改服务端的 PairCode）；如果它是连接态：中转服务器不掐掉已握手连接，所以旧的握手保持。
    // 但是一旦发生活跃断裂，RelayClient 会用原来的配对码重连吗？
    // 因此我们需要热更新 RelayClient 里的 pairCode!
    if (this.relayClient) {
      this.relayClient.pairCode = this.pairCode; 
    }
  }

  async startSystray() {
    // 非常简单的 Base64 小圆点图标 (或者内置一串默认黑色云图标)
    this.icon = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABHklEQVRYR+2WwQ3CMAxFnwQGgDFoRmED2rAAI7CBdJQZgA1oQxqGYYkDE0yQKtJSo05Q4i9Vihzbd+/5r0l0G/O78tOamANcEWAJ2INfOwc4/RbgGvgG5v/hX4Kig3fAa/8eYAX4lY6zAmx/bYClK21gXQEeHQRvDthWpA+cOwBv3hK8Bdx1AG98I3gHqF0GqPEb2a4A1B2gXAEVwP0yQMWVAKoA6hWg4p4GqAqoV4CKexqgKqBeASruaYCqgHoFqLinAaoCqk8A1d1aE6DuYVUB/LzKAlDdzTMB6p6aCeCVRgrwdhUlwNtVdIKk1gZ2yT3XyQ3XzZ6D5B4cW1fR129Gq6vp+Qp2J2sQ4tW7QogAAAAASUVORK5CYII=';

    this.systray = new SysTray({
      menu: {
        icon: this.icon,
        title: "CloudHand",
        tooltip: "CloudHand Mini-Term",
        items: this.buildMenuItems()
      },
      debug: false,
      copyDir: true // 在本地复制二进制文件以解决路径问题
    });

    this.systray.onClick(action => {
      if (action.seq_id === 0) {
        // [状态] 不可点击
      } else if (action.seq_id === 1) {
        // 点击复制配对码
        import('clipboardy').then(clip => clip.default.writeSync(this.pairCode));
        // 这里只是为了示意，systray2 不带类似气泡通知，但系统剪切板已改变
      } else if (action.seq_id === 2) {
        // 打开设置
        if (open) open('http://127.0.0.1:9899');
      } else if (action.seq_id === 3) {
        // 退出
        this.systray.kill();
        process.exit(0);
      }
    });

    this.systray.ready().then(() => {
      this.menuReady = true;
      this.updateTray();
    });
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
        title: `🔑 复制本机配对码: [ ${this.pairCode} ]`,
        tooltip: "点击复制密码并发送到聊天台",
        checked: false,
        enabled: true,
      },
      {
        title: "⚙️ 填入中继服务器地址",
        tooltip: "配置地址并连接",
        checked: false,
        enabled: true,
      },
      {
        title: "❌ 退出脱机终端",
        tooltip: "Exit",
        checked: false,
        enabled: true,
      }
    ];
  }

  updateTray() {
    if (!this.menuReady || !this.systray) return;
    this.systray.sendAction({
      type: 'update-menu',
      menu: {
        icon: this.icon,
        title: "CloudHand",
        tooltip: "CloudHand Mini-Term",
        items: this.buildMenuItems()
      }
    });
  }

  setConnStatus(status) {
    if (this.connStatus !== status) {
      this.connStatus = status;
      this.updateTray();
    }
  }

  startHttpServer() {
    this.httpServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <title>设备中继接入配置</title>
            <style>
              body { background: #0d1117; color: #c9d1d9; font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
              .box { background: #161b22; padding: 30px; border-radius: 8px; border: 1px solid #30363d; width: 340px; }
              h2 { font-size: 18px; margin-top: 0; padding-bottom: 12px; border-bottom: 1px solid #30363d; }
              label { display: block; font-size: 13px; color: #8b949e; margin: 15px 0 6px; }
              input { width: 100%; box-sizing: border-box; padding: 10px; background: #0d1117; border: 1px solid #30363d; color: #fff; border-radius: 6px; font-size: 14px; outline: none; transition: 0.2s border-color; }
              input:focus { border-color: #58a6ff; }
              .tip { font-size: 12px; color: #8b949e; margin-top: 8px; }
              .code-box { font-size: 18px; padding: 10px; text-align: center; letter-spacing: 2px; background: #010409; border: 1px dashed #58a6ff; border-radius: 6px; color: #58a6ff; font-weight: bold; margin-top: 15px; }
              button { margin-top: 20px; width: 100%; padding: 10px; background: #238636; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: 0.2s; }
              button:hover { background: #2ea043; }
              #msg { margin-top: 12px; font-size: 12px; text-align: center; color: #3fb950; display: none; }
            </style>
          </head>
          <body>
            <div class="box">
              <h2>☁️ CloudHand 终端桥接</h2>
              <label>远程中继主机地址 (例: ip:3456)</label>
              <input type="text" id="host" value="${this.settings.relayHost || ''}" placeholder="不填则无法连接云端" />
              
              <label>当前本机访问验证码 (每五分钟轮换)</label>
              <div class="code-box">${this.pairCode}</div>
              <div class="tip">请将此 6 位数配发给 OpenClaw 打通接入！</div>

              <button id="save">保存并强制握手重连</button>
              <div id="msg">✅ 设置已保存，正在后台建立通道</div>
            </div>
            <script>
              document.getElementById('save').addEventListener('click', async () => {
                const host = document.getElementById('host').value.trim();
                const btn = document.getElementById('save');
                btn.disabled = true;
                btn.innerText = '正在保存...';
                await fetch('/save', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ host })
                });
                document.getElementById('msg').style.display = 'block';
                setTimeout(() => window.close(), 1500); // 尝试自动关闭页
              });
            </script>
          </body>
          </html>
        `);
      } else if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            this.settings.relayHost = data.host;
            this.saveSettings();
            this.updateTray();
            this.connectRelay();
            res.writeHead(200); res.end('OK');
          } catch (e) {
            res.writeHead(400); res.end('Bad Request');
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.httpServer.listen(9899, '127.0.0.1', () => {
      console.log('[本机控制器] 监听于 http://127.0.0.1:9899');
    });
  }

  connectRelay() {
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
      pairCode: this.pairCode,
      sessionManager: this.sessionManager
    });

    // 这里需要改 relay-client.js 让它透出事件，因为我想知道 authenticated 没。
    // 但是我们只能覆盖一下 _send 和其内部处理状态。没关系，我们可以监听它的 websocket 底层，或者就直接通过 polling/改写 relayClient。
    const oldConnect = this.relayClient.connect.bind(this.relayClient);
    
    // 给 RelayClient 强行加钩子以便于在托盘中更新状态...
    this.relayClient.connect = () => {
      oldConnect();
      if (!this.relayClient.ws) return;
      
      this.relayClient.ws.on('open', () => this.setConnStatus('握手中...'));
      this.relayClient.ws.on('message', (raw) => {
        try { 
          const msg = JSON.parse(raw.toString()); 
          if (msg.type === 'auth_ok') {
             this.setConnStatus('🟢 已连通接入 (就绪)');
          } else if (msg.type === 'auth_fail') {
             this.setConnStatus('🔴 验证失败: ' + msg.reason);
          }
        } catch(e) {}
      });
      this.relayClient.ws.on('close', () => this.setConnStatus('❌ 穿透断开，尝试连回'));
      this.relayClient.ws.on('error', () => this.setConnStatus('❌ 无法路由到节点目标'));
    };

    this.relayClient.connect();
  }

  async run() {
    await this.startSystray();
    this.startHttpServer();
    this.connectRelay();
  }
}

const app = new TrayApp();
app.run();
