# CloudHand-Mini-Term 项目核心上下文

## 🔗 项目简介
CloudHand-Mini-Term (云手原生控制终端) 是一款极致安全的远程终端访问方案。它通过"逻辑分离"将受控端的执行权限与公网访问的中继服务彻底隔离开。

- **核心价值**：零暴露受控端地址，通过中继服务器进行穿透，支持 Windows 托盘常驻，多机并发接入。
- **当前状态**：已废弃配对码机制，全面采用 Token 直连认证。

## 🛠️ 核心架构
1. **中继端 (Relay Server)**:
   - 路径：`openclaw-skill/relay-server.js`
   - 功能：WebSocket 数据交换、Token 注册与验证（首来即信任）、Web 终端 UI 托管、多机路由。
   - 持久化：`openclaw-skill/clients.json`（已注册客户端列表，重启不丢失）。
   - 端口：默认 `3456`。
2. **执行端 (Tray App)**:
   - 路径：`src/tray-app.js` (由 `server.js` 启动)。
   - 功能：本地 PTY 管理 (`node-pty`)、系统托盘显示 (`systray2`)、Token 自动生成与持久化。
   - 端口：本地设置页面在 `9899`。

## 💻 本地开发环境 (Dong Ge's Setup)
- **操作系统**: Windows (宿主机)。
- **虚拟机**: Vagrant 管理，IP `192.168.56.12`，SSH 映射到 `127.0.0.1:2222` (用户: `root`, 密码: `vagrant`)。
- **数据库**:
  - MySQL 8.0: `3307` 端口。
  - MySQL 5.6: `3306` 端口。
- **工具链**: Node.js v16+ (推荐)。

## 📝 关键规则 (AI 指令补遗)
- **KISS 原则**: 优先保持代码简单可维护，避免过度设计。
- **安全第一**: 修改金钱/提现/认证逻辑时必须极度谨慎，防止重复点击。
- **环境隔离**: 敏感配置（如 Token、密码）应通过 `.env` 或 `settings.json` 管理。
