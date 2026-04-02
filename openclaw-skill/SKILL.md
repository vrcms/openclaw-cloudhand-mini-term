---
name: cloudhand-term
description: Connect to a user's local CloudHand Mini-Term for remote terminal access via WebSocket relay. Uses Token-based auto-registration with multi-machine support.
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm", "curl"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 远程终端连接 (Token 直连模式)

在这个非对称安全架构中，本地机器带着持久化 Token **主动连接**中继，无需配对码。

## 第一步：启动中继服务器

中继服务器只需指定端口即可启动：

```bash
cd {baseDir}
npm install --production 2>/dev/null
node relay-server.js --port <端口> &
```

确认中继已成功监听端口。告诉用户中继的**公网访问地址**。

> 注意：中继采用"首来即信任"机制——用户在本地启动客户端并配置中继地址后，客户端会自动带着 Token 连接中继，中继自动注册并记住该机器。**无需任何配对码操作。**

> 关于到访通知：只要有人成功打开终端页面联通机器，服务端控制台会打印日志 `[EVENT] 当前总共 x 个 UI 连接`。**请你（OpenClaw）主动提取该事件，并找到当前合适的任何消息渠道，主动通知主人："当前总共x个连接在你的电脑上"**。

## 第二步：等待用户连接

用户在本地电脑上运行 `npm run dev`，弹出的设置页面中填入中继地址，点击"连接"即可。

- 客户端首次启动会自动生成 UUID Token 和电脑名称
- 连接后中继自动注册该机器
- **你不需要做任何额外操作**，只要中继服务在运行，客户端就能自动连上

## 第三步：查看在线机器

你可以随时查询当前有多少台机器在线：

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

## 第五步：AI 自动控制协议（Agent Driver）

你（OpenClaw AI）可以**直接通过命令行脚本**控制用户的远程机器，无需打开浏览器。

### 获取目标机器 Token

先查询在线机器，找到 `connected: true` 的目标：
```bash
curl http://127.0.0.1:<端口>/api/clients
```

然后从 `clients.json` 读取对应机器的 Token：
```bash
cat {baseDir}/clients.json
```

### 执行单条命令

```bash
node {baseDir}/ai-agent-driver.js --token <TOKEN> --cmd "<命令>"
```

参数说明：
| 参数 | 必填 | 说明 |
|------|------|------|
| `--token`, `-t` | 是 | 目标机器的 Token |
| `--cmd`, `-c` | 是 | 要执行的命令 |
| `--port`, `-p` | 否 | 中继端口，默认 3456 |
| `--timeout` | 否 | 超时秒数，默认 10 |

### 示例

```bash
# 查看目标机器的文件列表
node ai-agent-driver.js --token a02c4c46-xxx --cmd "dir C:\\"

# 查看 Git 状态
node ai-agent-driver.js --token a02c4c46-xxx --cmd "git status" --timeout 5

# 执行一个较长的命令
node ai-agent-driver.js --token a02c4c46-xxx --cmd "npm test" --timeout 60
```

### 输出格式

- **stdout**：命令的纯文本输出（已自动剥离 ANSI 转义码/颜色）
- **stderr**：驱动脚本自身的日志和错误信息
- **退出码**：`0` = 成功，`1` = 失败（连接失败/终端未上线/超时）

### 安全注意事项

- Agent Driver **只能从中继服务器本机调用**（连接 `127.0.0.1`）
- **不要在日志中暴露 Token**——Token 等同于该机器的完全控制权
- 每次调用会创建一个临时 PTY 会话，命令执行完毕后自动关闭

---

## 第六步：Agent 对话协议（AI-to-AI 多轮对话）

CloudHand 支持 OpenClaw 通过 HTTP API 与本地 Claude CLI 进行多轮对话。这是一个 **AI 对 AI** 的通信协议，OpenClaw 作为"老板"给 Claude 下达任务指令。

### 原理

使用 Claude CLI 的 `-p`（非交互模式）+ `--resume`（上下文串联）+ `--output-format stream-json`（结构化输出）。每次对话 spawn 一个新进程，进程退出即表示回答完成。

### API 调用流程

```
1. POST /agent/start    → 初始化（设置工作目录、允许工具）
2. POST /agent/send     → 发送消息，同步等待 Claude 回复（可能需要 30-120 秒）
3. POST /agent/send     → 继续对话（自动带 --resume，Claude 能看到前续上下文）
4. ...（可反复调用 send）
5. POST /agent/stop     → 结束会话
```

#### 辅助 API
- `GET /agent/status`  — 查看当前状态（offline/idle/busy）
- `GET /agent/history` — 获取完整对话历史（用于 UI 面板排查）

### 示例调用

```bash
# 初始化
curl -X POST http://127.0.0.1:3456/agent/start \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/path/to/project"}'

# 第一轮对话
curl -X POST http://127.0.0.1:3456/agent/send \
  -H "Content-Type: application/json" \
  -d '{"message": "分析这个项目的目录结构"}'

# 第二轮（自动带上下文）
curl -X POST http://127.0.0.1:3456/agent/send \
  -H "Content-Type: application/json" \
  -d '{"message": "现在优化 index.js 的性能"}'

# 查看状态
curl http://127.0.0.1:3456/agent/status

# 结束
curl -X POST http://127.0.0.1:3456/agent/stop
```

### 注意事项

- 所有 `/agent/*` API **仅限 127.0.0.1 本地访问**
- `POST /agent/send` 是同步阻塞调用，需要设置足够长的 HTTP 超时（建议 120 秒以上）
- Agent 处于 `busy` 状态时，新的 `send` 请求会返回 `429 Too Many Requests`
- `POST /agent/stop` 会清空 session_id，下次 start 后是全新对话
