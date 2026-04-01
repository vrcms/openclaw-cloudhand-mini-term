require('dotenv').config();

const AuthManager = require('./src/auth');
const SessionManager = require('./src/session-manager');
const RemoteWsServer = require('./src/remote-ws');
const LocalServer = require('./src/local-server');

const REMOTE_PORT = parseInt(process.env.REMOTE_WS_PORT || '9876');
const LOCAL_PORT = parseInt(process.env.LOCAL_UI_PORT || '9877');

// 初始化核心模块
const authManager = new AuthManager();
const sessionManager = new SessionManager();

// 启动远程 WS 服务（等待 AI 智能体连入）
const remoteWs = new RemoteWsServer({
  port: REMOTE_PORT,
  authManager,
  sessionManager
});

// 启动本地 UI 服务（浏览器管理界面）
const localServer = new LocalServer({
  port: LOCAL_PORT,
  authManager,
  sessionManager
});

// 远程客户端状态变化通知本地前端
remoteWs.on('clientConnected', () => {
  localServer.broadcastRemoteStatus(true);
});
remoteWs.on('clientDisconnected', () => {
  localServer.broadcastRemoteStatus(false);
});

// 显示启动信息
const { pairCode } = authManager.getPairCode();
console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║     ☁️  CloudHand Mini-Term           ║');
console.log('╠══════════════════════════════════════╣');
console.log(`║  远程 WS:  ws://localhost:${REMOTE_PORT}       ║`);
console.log(`║  本地 UI:  http://localhost:${LOCAL_PORT}      ║`);
console.log(`║  配对码:   🔑 ${pairCode}                   ║`);
console.log('╚══════════════════════════════════════╝');
console.log('');

// 配对码刷新时控制台也更新
authManager.on('pairCodeChanged', ({ pairCode }) => {
  console.log(`[认证] 配对码已刷新: 🔑 ${pairCode}`);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭...');
  sessionManager.destroy();
  remoteWs.destroy();
  localServer.destroy();
  authManager.destroy();
  process.exit(0);
});
