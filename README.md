# CloudHand-Mini-Term (云手原生控制终端)

> [!CAUTION]
> **安全警告：本项目可通过公网中继服务器远程访问你的本地终端。请确保 Token 不被泄露，并只在受信任的环境中部署中继服务器。**

**极致安全的远程跨网段终端方案 + AI-to-AI 本地执行桥接**。本地托盘程序主动连接公网中继，实现零端口暴露的远程控制，并支持 OpenClaw AI 驱动本地 Claude CLI 进行 AI-to-AI 协作。

---

## 💡 核心架构：非对称安全双端分离

```
OpenClaw (公网 AI 智能体)
    │
    │  HTTP API (127.0.0.1 only)
    ▼
┌─────────────────────────────────┐
│  relay-server.js (公网中继服务器) │  ← 纯路由，无任何执行能力
│  提供: Web UI / WS 中转 / Agent API│
└────────────────┬────────────────┘
                 │ WebSocket (WS)
                 ▼
┌─────────────────────────────────┐
│  tray-app.js (本地托盘守护程序)  │  ← 只需要出站连接，无公网端口
│  relay-client.js (WS 客户端)    │
│  session-manager.js (PTY 管理器) │
└────────────────┬────────────────┘
                 │ 本地 spawn
                 ▼
         Claude CLI / Shell
        (运行在你的本地电脑上)
```

- **中继服务器**：部署在公网，只做消息路由，不执行任何命令。
- **本地托盘程序**：静默运行，主动连接中继，本地 PTY 和 Claude CLI 均在此执行。

---

## 🛡️ 安全特性

| 特性 | 说明 |
|------|------|
| 零端口暴露 | 本地机器完全通过主动出站 WS 长连接实现受控，无需开放任何公网端口 |
| Token 持久认证 | 首次启动自动生成 UUID Token，后续重连自动复用，无需手动配对 |
| 首来即信任 | 中继自动接受新 Token 注册，多台机器同时接入，Token 级别完全隔离 |
| Agent API 本地隔离 | 所有 `/agent/*` 接口**严格限制 127.0.0.1 访问**，公网无法触达 |
| 哑巴屏机制 | 无效 Token 访问时不返回任何有效信息，粉碎暴力枚举 |

---

## 🚀 快速部署

### 第一步：部署公网中继服务器

```bash
# 在你的公网服务器上
git clone https://github.com/vrcms/openclaw-cloudhand-mini-term.git
cd openclaw-cloudhand-mini-term/openclaw-skill
npm install
node relay-server.js --port 3456
```

### 第二步：启动本地托盘程序

在你想要被远程控制的本地电脑上：

```bash
npm install
npm run dev
```

启动后，右下角会出现 CloudHand 托盘图标，并自动打开本地设置页（`http://127.0.0.1:9899`）。

### 第三步：连接中继

在本地设置页中：
1. 填入**中继服务器地址**（如 `opc.example.com:3456`）。
2. 填入**电脑名称**（可选，默认取系统主机名）。
3. 点击 **「连接到中继服务器」**。
4. 显示 `🟢 已连通` 后，即可通过中继地址访问 Web 终端 UI。

### 第四步：访问 Web 终端

浏览器打开：
```
http://你的中继服务器地址:3456/?token=你的本地Token
```

---

## 🤖 AI-to-AI Agent Driver

OpenClaw 可通过中继的 HTTP API 控制本地 Claude CLI：

```bash
# 1. 初始化 Agent（指定目标机器的 Token）
curl -X POST http://127.0.0.1:3456/agent/start \
  -d '{"token": "<机器Token>", "cwd": "/path/to/project"}'

# 2. 发送任务（Claude 在本地执行并回传结果）
curl -X POST http://127.0.0.1:3456/agent/send \
  --max-time 180 \
  -d '{"message": "帮我重构一下 index.js"}'

# 3. 实时监控 Claude 执行过程（SSE 流）
curl -N http://127.0.0.1:3456/agent/stream

# 4. 查看对话历史
curl http://127.0.0.1:3456/agent/history

# 5. 停止 Agent
curl -X POST http://127.0.0.1:3456/agent/stop
```

> **注意**：Claude CLI 运行在**用户本地电脑**上，中继服务器只负责转发指令和结果。

---

## 🎨 Web UI 功能

| 功能 | 说明 |
|------|------|
| 多格布局 | 支持 1格、左右2格、上下2格、4格网格，一键切换 |
| Tab 管理 | 顶部 Tab 栏管理多个终端会话，支持双击重命名 |
| 拖拽分配 | 将 Tab 拖到目标格子即可将会话分配到该格子 |
| Agent 面板 | 右侧抽屉展示 AI-to-AI 对话记录，轮询实时更新 |

---

## 📂 项目结构

```
openclaw-cloudhand-mini-term/
├── server.js                    # 启动入口（加载 tray-app）
├── settings.json                # 本地配置（relayHost, token, computer_name）
├── src/
│   ├── tray-app.js             # 系统托盘 UI + 本地控制服务（9899端口）
│   ├── relay-client.js         # WS 客户端 + 本地 Claude CLI 执行驱动
│   └── session-manager.js      # PTY 会话管理（基于 node-pty）
└── openclaw-skill/
    ├── relay-server.js          # 公网中继服务（HTTP + WS + Agent API）
    ├── ui.html                  # Web 终端 UI（xterm.js）
    ├── login.html               # 公网屏蔽页（哑巴屏）
    ├── SKILL.md                 # OpenClaw 使用协议文档
    └── clients.json             # 已注册机器持久化（自动维护）
```

---

## 📄 依赖说明

**本地端**：`node-pty`（PTY）、`systray2`（托盘）、`ws`（WS 客户端）、`open`、`clipboardy`  
**中继端**：`ws`（WS 服务器）、Node.js 内置模块

---

*由 OpenClaw 设计，为 AI 协作与 DevOps 自动化打造。*
