---
name: cloudhand-term
description: Connect to a user's local CloudHand Mini-Term for remote terminal access via WebSocket relay. Uses Token-based auto-registration with multi-machine support.
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm", "curl"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 远程终端连接 (Token 直连模式)

在这个非对称安全架构中，本地机器带着持久化 Token **主动连接**中继，无需配对码。

## 架构说明

```
OpenClaw (公网 AI)
    │
    │ HTTP API (127.0.0.1)
    ▼
relay-server.js (中继服务器)
    │
    │ WebSocket 指令转发
    ▼
tray-app.js (用户本地终端控制)
    │
    │ 本地 spawn
    ▼
Claude CLI / Shell (运行在用户电脑上)
```

- **数据隔离**：OpenClaw 与中继交互，中继与本地交互，确保 OpenClaw 能操作用户本地文件和命令。
- **本地执行**：Claude CLI 运行在用户**本地电脑**上，能够访问本地代码库。

## 第一步：启动中继服务器

```bash
cd {baseDir}
npm install --production 2>/dev/null
node relay-server.js --port <端口> &
```

告诉用户中继的**公网访问地址**。用户在本地启动后，你会收到上线通知。

## 第二步：获取在线机器

```bash
curl http://127.0.0.1:<端口>/api/clients
```

## 第三步：AI-to-AI 对话协议 (Claude Agent Driver)

你可以通过中继服务器提供的 API，远程驱动用户本地机器上的 Claude CLI。

### 状态机

```
offline ──(POST /agent/start)──→ idle
idle    ──(POST /agent/send) ──→ busy (本地 Claude 正在执行)
busy    ──(结果回传)          ──→ idle
```

### 核心接口

#### 1. 初始化会话
**必须指定 `token` 来确定驱动哪台本地机器。**
```bash
curl -X POST http://127.0.0.1:<端口>/agent/start \
  -H "Content-Type: application/json" \
  -d '{"token": "<机器TOKEN>", "cwd": "C:\\my-project"}'
```

#### 2. 发送消息 (同步等待)
```bash
curl -X POST http://127.0.0.1:<端口>/agent/send \
  -H "Content-Type: application/json" \
  --max-time 180 \
  -d '{"message": "帮我重构一下 index.js"}'
```
> Claude 运行在用户本地。它会读取本地文件、执行本地测试。

#### 3. 实时监控 (SSE)
```bash
curl -N http://127.0.0.1:<端口>/agent/stream
```
即使 Claude 在用户本地运行，你也可以通过这个接口实时看到它的思考过程、使用的工具和输出的文本片段。

#### 4. 结束会话
```bash
curl -X POST http://127.0.0.1:<端口>/agent/stop
```

### 注意事项
1. **本地环境**：确保用户本地电脑已安装并登录了 `claude` (Claude Code CLI)。
2. **超时处理**：由于命令在本地执行并跨网络回传，建议超时时间设为 180 秒。
3. **安全提示**：Agent 操作的是用户本地环境，请确保你的指令是安全的。
