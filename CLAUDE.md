# CLAUDE.md

本项目已重构，本指南旨在为 AI 生成/调试代码时提供准确的项目背景信息。

## 🚀 项目概述

CloudHand-Mini-Term (云手原生控制终端) — 基于 Node.js 的本地终端管理桌面应用，作为远程 OpenClaw AI 智能体与本地系统之间的安全桥梁。

## 🛠️ 技术栈

- **核心运行环境**: Node.js (v16+)
- **PTY 驱动**: node-pty
- **中继通讯**: WebSocket (ws)
- **托盘管理器**: systray2
- **前端渲染**: xterm.js (集成在 `openclaw-skill/ui.html`)
- **UI 风格**: 原生 JavaScript + 暗黑模式 CSS

## 💻 关键命令

```bash
# 安装依赖
npm install

# 以后台系统托盘模式启动本地执行端
npm run dev

# 启动公网中继端 (在服务器上运行)
cd openclaw-skill
node relay-server.js --port=3456
```

## 🏗️ 架构约定

- **双端分离**: 中继端 (`relay-server.js`) 只负责路由转发，执行端 (`tray-app.js`) 负责 PTY 生成。
- **Token 直连认证**:
  - 本地启动时自动生成 UUID Token，持久化到 `settings.json`。
  - 中继服务器采用"首来即信任"策略，自动接受新 Token 注册。
  - Token 同时用于本地→中继的 WS 认证和浏览器→中继的 Web 访问。
- **多机并发**: 中继支持多台本地机器同时接入，每台机器通过独立 Token 隔离。
- **客户端注册表**: 中继将已连接机器信息持久化到 `clients.json`，重启不丢失。
- **自动清理**: 超过1小时未连接且不在线的机器记录自动清理。
- **项目结构**:
  - `src/` — 本地执行端逻辑 (Tray App, SessionManager, RelayClient)。
  - `openclaw-skill/` — 中继服务端逻辑 (Relay Server, Web UI)。
  - `contexts/` — 核心背景文档。
- **配置持久化**:
  - `settings.json` — 存储中继主机地址、Token、电脑名称。
  - `clients.json` — 中继端持久化已注册客户端 (自动维护)。
  - `.env` — 环境变量支持。

## ⚠️ 开发规则

1. **中文优先**: AI 解释与注释使用中文，技术术语保留英文。
2. **KISS 原则**: 保持代码精简，避免引用过重的库（除非必要）。
3. **错误提示**: 认证失败应静默，不向公网泄露具体原因细节（参考 `login.html` 的哑巴屏逻辑）。
