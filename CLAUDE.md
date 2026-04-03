# CLAUDE.md

本项目 AI 辅助开发指南，为代码生成与调试提供准确的项目背景信息。

## 🚀 项目概述

**CloudHand-Mini-Term (云手原生控制终端)** — 基于 Node.js 的远程终端桥接应用。本地托盘程序（Tray App）通过 WebSocket 连接公网中继服务器，实现安全的远程终端接入，并支持 AI-to-AI 协作（OpenClaw 通过 HTTP API 驱动本地 Claude CLI）。

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 核心运行时 | Node.js (v16+) |
| PTY 驱动 | `node-pty` |
| WS 通信 | `ws` |
| 系统托盘 | `systray2` |
| 前端终端 | `xterm.js` (集成在 `openclaw-skill/ui.html`) |
| 进程管理 | Node.js `child_process.spawn` |

## 💻 关键命令

```bash
# 安装本地端依赖
npm install

# 启动本地托盘端 (执行端)
npm run dev          # 等同于 node server.js

# 安装中继端依赖 (服务器上)
cd openclaw-skill && npm install

# 启动公网中继服务器
node openclaw-skill/relay-server.js --port 3456
```

## 🏗️ 架构约定

### 两端分离架构

```
OpenClaw (公网 AI)
    │  HTTP API (127.0.0.1 only)
    ▼
relay-server.js     ← 部署在公网服务器，仅做路由转发
    │  WebSocket 指令转发
    ▼
relay-client.js     ← 运行在用户本地电脑，隶属 tray-app.js
    │  本地 spawn
    ▼
claude CLI / PTY    ← Claude 和终端 shell 均运行在本地
```

- **中继（relay-server.js）**：纯路由层，无任何执行能力，不本地 spawn 任何进程。
- **本地（tray-app.js + relay-client.js）**：所有 PTY 会话和 Claude CLI 均在此执行。

### Token 认证机制

- 本地首次启动自动生成 UUID Token，写入 `settings.json` 持久化。
- 中继采用**"首来即信任"**策略：只验证 Token 格式（长度 ≥ 16），自动登记，后续重连使用同一 Token。
- 浏览器访问 Web UI 时，Token 从 URL 参数（`?token=`）读取，可 fallback 到 Cookie。
- Token 同时用于：本地→中继 WS 认证 / 浏览器→中继 WS UI 认证。

### Agent Driver (AI-to-AI)

OpenClaw 通过本地 HTTP API 驱动 Claude CLI：

| 接口 | 说明 |
|------|------|
| `POST /agent/start` | 选定目标机器 Token，初始化会话 |
| `POST /agent/send` | 发送指令，中继转发 WS 消息给本地，在本地执行 `claude -p`，等待回传 |
| `GET /agent/stream` | SSE 实时流，接收 Claude 执行过程中的中间事件（文本片段、工具调用等）|
| `GET /agent/status` | 查询当前 Agent 状态 |
| `GET /agent/history` | 查询对话历史 |
| `POST /agent/stop` | 停止会话 |

> **重要**：所有 `/agent/*` 接口仅接受 `127.0.0.1` 的请求（`isLocalRequest()` 严格校验）。

### WS 消息协议（终端 + Agent）

| 方向 | 消息类型 | 说明 |
|------|---------|------|
| 中继→本地 | `agent_query` | 驱动本地执行 Claude CLI |
| 本地→中继 | `agent_stream` | 实时回传 Claude 输出事件 |
| 本地→中继 | `agent_result` | Claude 执行完毕，回传最终结果 |
| 中继→本地 | `agent_abort` | 中断当前 Claude 进程 |

## 📂 文件职责

| 文件 | 职责 |
|------|------|
| `server.js` | 入口，启动 `tray-app.js` |
| `src/tray-app.js` | 系统托盘 UI、设置页、本地控制服务 (9899端口) |
| `src/session-manager.js` | PTY 会话的增删改查，封装 `node-pty` |
| `src/relay-client.js` | WS 客户端：连接中继、转发终端事件、**在本地执行 claude CLI** |
| `openclaw-skill/relay-server.js` | 中继 HTTP/WS 服务、Agent API 路由 |
| `openclaw-skill/ui.html` | 浏览器 Web 终端 UI（多格布局、Agent 面板）|
| `openclaw-skill/login.html` | 公网访问时的屏蔽页（哑巴屏）|
| `openclaw-skill/SKILL.md` | 供 OpenClaw 阅读的使用协议文档 |
| `settings.json` | 本地配置（relayHost、token、computer_name）|
| `openclaw-skill/clients.json` | 中继持久化已注册客户端（自动维护，勿手动编辑）|

## ⚠️ 开发规则

1. **中继不执行任何本地进程**：严禁在 `relay-server.js` 中 `spawn`。
2. **Claude 本地执行**：`relay-client.js` 的 `_handleAgentQuery` 负责在本地 `spawn('claude', ['-p', ...])`，调用时必须 `proc.stdin.end()` 避免 `Request interrupted by user` 报错。
3. **Agent API 仅限本地**：`/agent/*` 路由必须通过 `isLocalRequest(req)` 校验。
4. **KISS 原则**：避免引入非必要依赖。
5. **中文优先**：AI 注释使用中文，技术术语保留英文。
