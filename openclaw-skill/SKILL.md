name: cloudhand-term
description: 远程 AI 的“本地手脚”。通过 WebSocket 中继操控用户本地终端和 Claude CLI，实现本地文件查询、环境探测与多轮协作开发。
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm", "curl"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 本地执行桥梁与 Agent 驱动

> [!TIP]
> **什么时候该用这个技能？**
> 当你作为一个远程 AI，发现当前的云端沙箱无法满足以下需求时，**必须**调用此技能：
> 1. **查询本地资料**：读取用户电脑上的代码库、日志文件、配置文件（如：`帮我看看 D:\www 下的项目结构`）。
> 2. **执行本地环境探测**：检查用户电脑的环境变量、已安装软件版本（如：`curl -I`）。
> 3. **进行本地闭环开发**：编译、打包、测试或直接驱动本地 Claude CLI 进行深度 debug。
> 4. **打破沙箱限制**：当你需要一个真实的、具有文件持久化能力的 Linux/Windows/Mac 终端环境时。

## 架构说明与核心价值

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

## 核心工作流与激活 (Lifecycle & Activation)

你要使这个技能“活起来”，通常需要遵循以下生命周期：

1. **部署控制面**：确保 `openclaw-skill/relay-server.js` 正在运行（见下方《第零步》）。
2. **建立物理连接**：用户在本地启动 `server.js` (托盘程序) 并输入中继地址进行连接。
3. **发现并绑定机器**：
   - 调用 `/api/clients` 获取当前在线的所有机器。
   - 提取目标机器的 `token`。
4. **初始化会话**：通过 `POST /agent/start` 激活特定机器的 Claude PTY 驱动。
5. **任务闭环**：通过 `POST /agent/send` 发送指令 -> 获取回复内容 -> 展示结果给用户。

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

## 状态感知与异步就绪 (State Awareness)

由于 Claude CLI 属于重量级应用，**冷启动 (First Start) 可能需要 30-60 秒**。作为调用方 AI，你必须学会“异步等待”：

### 1. 监听就绪流 (SSE)
在执行 `POST /agent/start` 后，建立 `GET /agent/stream` 连接并监听：
- **等待信号**：直到收到 `{"type": "status", "state": "idle"}`，才代表 PTY 已加载完毕。
- **过程中信号**：你可能会收到 `{"type": "status", "state": "busy"}`，说明它正在努力加载中。

### 2. 本动查询 (Polling)
如果无法建立长连接，请轮询 `GET /agent/status`：
- **状态切换**：只有当 `state` 从 `starting` 变为 `idle` 时，才可发送第一条指令。

---

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
> [!IMPORTANT]
> **作为代理 AI，你必须完整且透明地展示返回的 `reply` 原始内容。禁止仅提示“已收到内容”，用户需要看到 Claude 在本地执行产生的具体输出信息。**
>
> Claude CLI 可能会执行很久，底层超时时间长达 600 秒 (10分钟)。
```bash
curl -X POST http://127.0.0.1:<端口>/agent/send \
  -H "Content-Type: application/json" \
  --max-time 605 \
  -d '{"message": "帮我查询一下 D:\www\logs 下最近的错误日志"}'
```
**返回值：**
`{"ok": true, "reply": "这是来自本地电脑的一段真实文件内容和终端输出..."}`

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

## AI-to-AI 协作与验收规范 (Collaboration Protocol)

为确保远程智能体之间高效、可靠地完成任务，必须遵循以下协作准则：

### 1. 极简技术通讯 (No Fluff)
- **禁止社交辞令**：严禁发送“好的”、“没问题”、“很高兴为你服务”等废话。
- **直奔主题**：调用方 AI 应直接发送技术指令或验证逻辑；响应方 AI 直接返回执行结果。

### 2. 验证驱动验收 (Verification Driven)
- **不盲信结论**：当本地 Claude 返回“任务已完成”或“修复完毕”时，调用方 AI **必须**启动独立验证。
- **校验手段**：使用 `cat` 查看文件 diff、使用 `ls` 检查文件存在性、执行 `npm test` 或编译命令验证功能。
- **打回整改**：如果校验未通过，直接指出逻辑漏洞或 Error Stack，要求本地端立即修正。

### 3. 禁止擅权停止 (Human-in-the-Loop)
- **严禁自动执行 `/agent/stop`**：即便任务已完美达标且通过所有验证，调用方 AI **也绝对禁止**擅自关闭会话。
- **归还裁决权**：验证达标后，应向人类用户（东哥）详细汇报成果（包括已执行的验证操作），并询问“是否结束会话/清理资源”。
- **静默待命**：在得到人类明确授权前，必须保持在 `idle` 状态，以便人类进行人工二次核验。

### 核心规范与注意事项

1. **对话持久化 (Session Persistence)**：
   - **禁止主动断开**：除非由于网络异常或用户明确指令（如“结束对话”、“关闭会话”），否则**禁止**调用 `/agent/stop`。
   - **上下文保持**：本地 Claude CLI 是通过 PTY 进程维持的，只要不执行 `stop`，所有的本地修改记录、变量状态和对话上下文都会被保留。
   - **状态停留**：完成一轮 `send` 后，必须保持在 `idle` 状态，等待下一轮指令。

2. **Windows PTY 限制**：本地端在 Windows 上使用 `node-pty` 时必须通过 `cmd.exe /c claude` 发起，客户端代码已做系统适配。
3. **长超时与冷启动 (Cold Start)**：
   - AI-to-AI 自动执行包含编译、安装等耗时操作，客户端和中继服务器均支持 600s 的长请求生命周期。
   - **冷启动窗口**：Claude 进程初始化在低配或高负载机器上可能长达 60s，脚本已适配 60s 的防抖时间，请 AI 在调用 `/agent/start` 后耐心等待 `idle` 信号。
4. **Web UI 集成**：Agent 的历史记录会同步到 `ui.html` 右侧抽屉。
5. **任务清理**：仅在用户明确表示任务彻底结束或需要从其他目录重启时，才调用 `/agent/stop` 释放资源。
