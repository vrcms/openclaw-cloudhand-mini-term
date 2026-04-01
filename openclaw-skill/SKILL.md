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
