---
name: cloudhand-term
description: Connect to a user's local CloudHand Mini-Term for remote terminal access via WebSocket relay. Uses Token-based auto-registration, global PTY Claude Driver, and permission interception.
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm", "curl"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 远程终端连接与 Agent 驱动

在这个非对称安全架构中，本地机器带持久化 Token **主动连接**中继，无需配对码。中继服务器仅做消息转发（纯 HTTP/WS 路由层），**不执行**任何终端命令或 AI 代码。所有的终端交互和 Claude CLI 均在用户**本地电脑**上执行。

## 架构说明

```
OpenClaw (你可以视为公网或本地的 AI 调度者)
    │
    │ HTTP API 控制指令 (127.0.0.1 限制)
    ▼
relay-server.js (中继服务器，仅作路由映射)
    │
    │ WebSocket JSON 转发协议 ({ type: 'agent_query', message: ... })
    ▼
tray-app.js + relay-client.js (用户本地终端控制)
    │
    │ node-pty 驱动 (Windows: cmd.exe /c claude, Mac/Linux: claude)
    ▼
Claude CLI 主进程 (在用户电脑上持续运行，拥有本地文件读写权限)
```

- **数据隔离**：OpenClaw 控制中继，中继转发消息给本地客户端。Claude 的一切执行产生于本地，中继不保留状态。
- **PTY 驱动模式**：Claude CLI 是一个长连接的 PTY 进程，能保留上下文，并被 `relay-client` 解析画布状态（`idle`, `busy`, 权限提示等）。

## 第零步：环境就绪自检 (Pre-flight Check)

在使用本 Skill 前，必须确保 **Relay Server (中继服务器)** 已在运行。如果没有启动，后续 API 调用将全部失败。

### 1. 探测服务状态 (默认端口 3456)
```bash
# 检查 API 是否响应
curl -s http://127.0.0.1:3456/api/clients || echo "Relay Server is OFFLINE"
```

### 2. 启动/重置服务 (如果探测失败)
如果你是开发者或在中继服务器环境下，请执行：
```bash
# 进入项目根目录并确保环境干净
npx kill-port 3456
npm install
node openclaw-skill/relay-server.js --port 3456 > relay.log 2>&1 &
```

> [!IMPORTANT]
> **切记**：`openclaw-skill/relay-server.js` 是 AI 控制的中枢，必须第一个启动。本地托盘程序 (`server.js`) 启动后会自动连接至此中继。

## 第一步：启动中继服务器

```bash
cd {baseDir}
npm install --production 2>/dev/null
node openclaw-skill/relay-server.js --port <端口> &
```

启动后，Web UI 可以通过 `http://<服务器IP>:<端口>` 访问。本地端连接后，会在中继注册。

## 第二步：获取在线机器

```bash
curl http://127.0.0.1:<端口>/api/clients
```

## 第三步：AI-to-AI 对话协议 (Claude Agent Driver)

你可以通过中继服务器提供的 API，远程驱动用户本地机器上的 Claude CLI 进行结对编程。
**注意：POST 控制接口仅限 127.0.0.1 访问；GET 查询接口开放给 Web UI 但需带 `?token=`。**

### 状态机

```
offline ──(POST /agent/start)──────→ idle
idle    ──(POST /agent/send) ──────→ busy (本地 Claude 正在思考/执行)
busy    ──(侦测到权限确认)   ──────→ waiting_permission
waiting_permission ──(POST /agent/permission) ─→ busy
busy    ──(探测到 ❯ 提示符)  ──────→ idle (回传结果)
```

### 核心接口

#### 1. 初始化会话
启动本地机器的 Claude CLI PTY 进程。
**必须指定 `token` 来确定驱动哪台在线机器。**
```bash
curl -X POST http://127.0.0.1:<端口>/agent/start \
  -H "Content-Type: application/json" \
  -d '{"token": "<机器TOKEN>"}'
```

#### 2. 发送消息 (同步等待或轮询)
将指令发送给本地的 Claude。如果本地 Claude 还未就绪 (STARTING/BUSY)，会返回 429 或回复 `[ERROR]`。
> Claude CLI 可能会执行很久，底层超时时间长达 600 秒 (10分钟)。
```bash
curl -X POST http://127.0.0.1:<端口>/agent/send \
  -H "Content-Type: application/json" \
  --max-time 605 \
  -d '{"message": "帮我重构一下 index.js"}'
```
**返回值：**
如果遇到本地机器权限请求，`needsPermission` 会为 `true`：
`{"ok": true, "needsPermission": true, "prompt": "Do you want to run this command (y/n)?" }`

#### 3. 处理权限请求
如果在 `/agent/send` 收到了 `needsPermission: true`，说明 Agent 状态已进入 `waiting_permission`。你需要调用此接口批准或拒绝：
```bash
curl -X POST http://127.0.0.1:<端口>/agent/permission \
  -H "Content-Type: application/json" \
  --max-time 605 \
  -d '{"allow": true}'
```
> 这个请求也会**阻塞**直到 Claude 再次进入 `idle` 出结果（或超时）。

#### 4. 获取聊天记录与状态 (GET API)
Web UI 读取记录使用，**必须带上 `?token=` 进行鉴权隔离**。
```bash
curl "http://localhost:<端口>/agent/status?token=<机器TOKEN>"
curl "http://localhost:<端口>/agent/history?token=<机器TOKEN>"
curl -N "http://localhost:<端口>/agent/stream?token=<机器TOKEN>"
```

#### 5. 结束会话
销毁本地的 Claude PTY 进程。
```bash
curl -X POST http://127.0.0.1:<端口>/agent/stop
```

### 注意事项
1. **Windows PTY 限制**：本地端在 Windows 上使用 `node-pty` 时必须通过 `cmd.exe /c claude` 发起，客户端代码已做系统适配。
2. **长超时**：AI-to-AI 自动执行包含编译、安装等耗时操作，客户端和中继服务器均支持 600s 的长请求生命周期。
3. **Web UI 集成**：Agent 的历史记录会同步到 `ui.html` 右侧抽屉。
4. **清理会话**：任务结束时，别忘了调用 `/agent/stop` 释放用户的系统资源。
