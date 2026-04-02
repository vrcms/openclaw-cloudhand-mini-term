---
name: cloudhand-term
description: Connect to a user's local CloudHand Mini-Term for remote terminal access via WebSocket relay. Uses Token-based auto-registration with multi-machine support.
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm", "curl"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 远程终端连接 (Token 直连模式)

在这个非对称安全架构中，本地机器带着持久化 Token **主动连接**中继，无需配对码。

## 架构说明（先读这个）

```
OpenClaw (公网 AI)
    │
    │ HTTP API (127.0.0.1)
    ▼
relay-server.js  ← 运行在公网服务器上，这是 openclaw-skill 的核心
    │
    │ WebSocket 长连接
    ▼
tray-app.js (本地托盘应用)  ← 运行在用户电脑上，管理终端 PTY 会话
    │
    │ node-pty
    ▼
用户本地终端 (Shell/PowerShell)
```

- **你（OpenClaw）只和 relay-server.js 交互**
- relay-server.js 在 `openclaw-skill/` 目录，唯一的文件是 `relay-server.js`
- 本地用户运行 `npm run dev` 启动托盘应用（`src/tray-app.js`），它会主动连接到中继

## 第一步：启动中继服务器

```bash
cd {baseDir}
npm install --production 2>/dev/null
node relay-server.js --port <端口> &
```

确认中继已成功监听端口。告诉用户中继的**公网访问地址**。

> 注意：中继采用"首来即信任"机制——用户在本地启动托盘应用并配置中继地址后，客户端会自动带着 Token 连接中继，中继自动注册并记住该机器。**无需任何配对码操作。**

> 关于到访通知：只要有人成功打开终端页面联通机器，服务端控制台会打印日志 `[EVENT] 当前总共 x 个 UI 连接`。**请你（OpenClaw）主动提取该事件，并找到当前合适的任何消息渠道，主动通知主人：「当前总共x个连接在你的电脑上」**。

## 第二步：等待用户连接

用户在本地电脑上运行 `npm run dev`，弹出的设置页面（`http://127.0.0.1:9899`）中填入中继地址，点击"连接"即可。

- 客户端首次启动会自动生成 UUID Token 和电脑名称
- 连接后中继自动注册该机器
- **你不需要做任何额外操作**，只要中继服务在运行，客户端就能自动连上

## 第三步：查看在线机器

```bash
curl http://127.0.0.1:<端口>/api/clients
```

返回格式：
```json
[
  {"computer_name": "东哥的主力机", "connected": true, "lastSeen": 1711900800000},
  {"computer_name": "办公室电脑", "connected": false, "lastSeen": 1711897200000}
]
```

## 第四步：后续维护

### 正常运行中
- 本地客户端断线会**自动重连**，无需人工干预
- 本地重启后也会**自动用存储的 Token 恢复连接**
- 多台电脑可同时连接同一个中继，互不干扰

### 什么时候需要主人介入
- 中继服务崩溃需要重启时（重启后客户端会自动重新连上）
- 超过 1 小时未连接的机器记录会被自动清理（下次连接时自动重新注册）

## 注意事项

- **Token 是永久凭证**：每台机器有唯一的 UUID Token，保存在本地 `settings.json` 中
- **首页安全防护**：访问中继网页无 Token 时，只显示"请从本机启动"的提示页
- **多机隔离**：每台机器的终端会话互不可见，Web UI 通过 Token 路由到对应机器
- **自动清理**：中继每 10 分钟清理超过 1 小时未连接的机器注册记录

---

## 第五步：AI-to-AI 对话协议（Claude Agent Driver）

CloudHand 支持 OpenClaw 通过本地 HTTP API 在**中继服务器上**直接启动 Claude CLI，实现 AI 对 AI 的多轮编程协作。

> **注意**：这里的 Claude 是运行在**中继服务器**上的，不是用户本地电脑。确保中继服务器上已安装 `claude` CLI。

### 核心原理

使用 Claude CLI 的 `-p`（非交互模式）+ `--resume`（上下文串联）+ `--output-format stream-json`。
**每次对话 spawn 一个子进程，进程退出 = 回答完成。**

### 状态机

```
offline ──(POST /agent/start)──→ idle
idle    ──(POST /agent/send) ──→ busy（Claude 正在执行任务）
busy    ──(进程退出)          ──→ idle
idle    ──(POST /agent/stop) ──→ offline
```

| 状态 | 含义 |
|------|------|
| `offline` | Agent 未初始化，请先 `start` |
| `idle` | 空闲，等待你发 `send` |
| `busy` | Claude 正在思考/执行，**此时发 send 会返回 429** |

### 所有 API（仅限 127.0.0.1 本地访问）

#### 初始化会话
```bash
curl -X POST http://127.0.0.1:<端口>/agent/start \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/path/to/project", "allowedTools": ["Read","Edit","Bash","Write"]}'
# 响应: {"ok": true, "state": "idle"}
```

#### 发送消息（同步等待，最长 30-120 秒）
```bash
curl -X POST http://127.0.0.1:<端口>/agent/send \
  -H "Content-Type: application/json" \
  --max-time 180 \
  -d '{"message": "分析这个项目的目录结构"}'
# 响应: {"ok": true, "reply": "...", "sessionId": "xxx", "exitCode": 0, "state": "idle"}
```

#### 查询状态
```bash
curl http://127.0.0.1:<端口>/agent/status
# 响应: {"state": "busy", "sessionId": "xxx", "cwd": "/path", "totalTurns": 3}
```

#### 实时事件流（SSE，推荐用于监控进度）
```bash
curl -N http://127.0.0.1:<端口>/agent/stream
```

连接后持续收到事件：
```
data: {"type":"status","state":"idle","sessionId":null}     ← 连接时快照

data: {"type":"status","state":"busy"}                      ← 开始执行
data: {"type":"text","text":"正在分析目录结构..."}
data: {"type":"tool_use","tool":"Bash","input":{"command":"ls -la"}}
data: {"type":"text","text":"项目结构如下：..."}
data: {"type":"result","text":"分析完成","exitCode":0}
data: {"type":"status","state":"idle"}                      ← 执行完毕
```

#### 获取历史记录
```bash
curl http://127.0.0.1:<端口>/agent/history
```

#### 结束会话
```bash
curl -X POST http://127.0.0.1:<端口>/agent/stop
# 响应: {"ok": true, "state": "offline"}
```

### OpenClaw 标准工作流

```
1. POST /agent/start   → 确认 state = "idle"
2. POST /agent/send {message: "第一个任务"}  → 用 --max-time 180
3. 读 send 响应体里的 reply（完整回复文本）
4. state 自动回到 "idle"，可继续发下一轮（自动带上下文）
5. 完成后 POST /agent/stop
```

可选：用 `GET /agent/stream`（后台保持长连接）实时监控 Claude 工作进度，而不是傻等 send 返回。

### 约束
- `send` 是同步阻塞，**busy 时不要再发 send**（返回 429）
- `--max-time 180`：Claude 单轮最多 2 分钟
- `stop` 清空 session_id，下次 `start` 后是全新对话
- `exitCode != 0` 说明 Claude 出错，看 `reply` 字段了解原因
