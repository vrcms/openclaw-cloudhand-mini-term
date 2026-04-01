require('dotenv').config();

// ==================== 解析 CLI 参数 ====================

let relayHost = null;
let relayPairCode = null;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--host=')) relayHost = arg.split('=')[1];
  if (arg.startsWith('--paircode=')) relayPairCode = arg.split('=')[1];
}

// ==================== 模式分支 ====================

if (relayHost && relayPairCode) {
  // ---- 中继模式：主动连接远程中继服务器 ----
  const SessionManager = require('./src/session-manager');
  const RelayClient = require('./src/relay-client');

  const sessionManager = new SessionManager();
  const relayClient = new RelayClient({
    relayHost,
    pairCode: relayPairCode,
    sessionManager
  });

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     ☁️  CloudHand Mini-Term (中继模式)    ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  中继地址:  ${relayHost}`);
  console.log(`║  配对码:    🔑 ${relayPairCode}`);
  console.log('║  状态:      ⏳ 正在连接中继...');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  relayClient.connect();

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n正在关闭...');
    sessionManager.destroy();
    relayClient.destroy();
    process.exit(0);
  });

} else {
  // ---- 本地模式：原有的本地服务 ----
  const AuthManager = require('./src/auth');
  const SessionManager = require('./src/session-manager');
  const RemoteWsServer = require('./src/remote-ws');
  const LocalServer = require('./src/local-server');

  const REMOTE_PORT = parseInt(process.env.REMOTE_WS_PORT || '9876');
  const LOCAL_PORT = parseInt(process.env.LOCAL_UI_PORT || '9877');

  const authManager = new AuthManager();
  const sessionManager = new SessionManager();

  const remoteWs = new RemoteWsServer({
    port: REMOTE_PORT,
    authManager,
    sessionManager
  });

  const localServer = new LocalServer({
    port: LOCAL_PORT,
    authManager,
    sessionManager
  });

  remoteWs.on('clientConnected', () => {
    localServer.broadcastRemoteStatus(true);
  });
  remoteWs.on('clientDisconnected', () => {
    localServer.broadcastRemoteStatus(false);
  });

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

  authManager.on('pairCodeChanged', ({ pairCode }) => {
    console.log(`[认证] 配对码已刷新: 🔑 ${pairCode}`);
  });

  process.on('SIGINT', () => {
    console.log('\n正在关闭...');
    sessionManager.destroy();
    remoteWs.destroy();
    localServer.destroy();
    authManager.destroy();
    process.exit(0);
  });
}
