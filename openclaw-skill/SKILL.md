---
name: cloudhand-term
description: Connect to a user's local CloudHand Mini-Term for remote terminal access via WebSocket relay.
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 远程终端连接

当用户要求连接他们的本地终端（如 "连接我电脑的终端", "connect to my terminal", "打开远程终端"）时，按以下步骤执行：

## 第一步：启动中继服务器

1. 生成一个 6 位随机配对码（如 `123456`）
2. 选择一个可用端口（默认 `3456`，如果被占用则递增）
3. 安装依赖并启动中继服务器：

```bash
cd {baseDir}
npm install --production 2>/dev/null
node relay-server.js --pair-code <配对码> --port <端口> &
```

4. 确认中继服务器已启动（检查端口是否在监听）

## 第二步：告知用户运行本地命令

确定当前主机的公网地址或域名（可通过 `hostname -I`, `curl ifconfig.me`, 或已知的域名配置获取），然后告诉用户：

> 好的，请在你的电脑上打开一个终端，进入 CloudHand Mini-Term 项目目录，运行以下命令：
>
> ```
> node server.js --paircode=<配对码> --host=<公网地址>:<端口>
> ```
>
> 运行后它会自动连接到我这边。

## 第三步：等待连接建立

轮询中继服务器状态，等待本地终端连接：

```bash
curl -s http://localhost:<端口>/api/status
```

当 `terminalConnected` 为 `true` 时，连接已建立。

## 第四步：通知用户连接成功

连接成功后，告诉用户：

> 🎉 好消息！我们已经成功连接到你的电脑了！
>
> 现在打开这个链接来使用远程终端：
> **http://<公网地址>:<端口>**
>
> 页面左侧是会话管理列表，右侧是你电脑的终端。

## 与终端交互

连接建立后，你可以通过 REST API 与终端交互：

### 发送终端命令
```bash
curl -X POST http://localhost:<端口>/api/exec \
  -H "Content-Type: application/json" \
  -d '{"command": "ls -la\n", "sessionId": "s1"}'
```

```

### 查询连接状态
```bash
curl -s http://localhost:<端口>/api/status
```

## 注意事项

- 中继服务器一次只允许一个本地终端连接
- 配对码用于验证本地终端的身份，确保连接安全
- 如果用户断开重连，需要使用相同的配对码
- Web UI 通过 CDN 加载 xterm.js，用户的浏览器需要能访问外网
