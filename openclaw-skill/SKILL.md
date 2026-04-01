---
name: cloudhand-term
description: Connect to a user's local CloudHand Mini-Term for remote terminal access via WebSocket relay. Requires handling Token-based auth and internal pair-code hot reloading.
metadata: { "openclaw": { "emoji": "☁️", "requires": { "bins": ["node", "npm", "curl"] }, "os": ["darwin", "linux", "win32"] } }
---

# CloudHand Terminal — 远程终端连接 (极严密防护模式)

在这个极具赛博分离架构的终端桥接系统中，整个访问逻辑围绕着**五分钟动态锁**与**内部命令提权**展开。

## 第一步：启动中继服务器（门禁架设）

中继服务器仅提供通道，不负责决定正确的接入配对码，因为配对码是由**用户本地运行的托盘客户端每 5 分钟生成的**。

1. 你只需启动中继服务器，随便赋一个随机的临时防撞密码和找一个不互斥的端口（如 `3456`）：

```bash
cd {baseDir}
npm install --production 2>/dev/null
node relay-server.js --pair-code <随机临时6位> --port <端口> &
```

2. 确认中继已成功监听端口待命。并且告诉用户这个系统的公网访问**中继链接**。

## 第二步：等待密旨在内网热更！

系统运转前，你须等待用户在聊天框里汇报他托盘当前正在生效的**6位数字配对码**。
如果你看到用户发口令（如"我新密码是283371", "本地改了,445588"），你必须**立刻**调用受白名单严格保护的 `127.0.0.1` 管理通道，热更新中继的安全凭证：

```bash
curl -X POST http://127.0.0.1:<端口>/api/internal/paircode \
  -H "Content-Type: application/json" \
  -d '{"pairCode": "<用户报的配对码>"}'
```

一旦更新，公网上的中继服务器会在几秒内成功校验通过用户本地那台不断“撞门”重试的托盘客机。
接着，在对话中回答：“锁定解除，本地已与公网中继器双向握手联通！”

## 注意事项与常见错误排查

- **禁止网页泄漏密码指南**：`GET /` 现在是一个哑巴密码输入框，它绝不会泄露怎么使用或者向访客生成推荐配对码。任何人想获得权限的唯一入口在于拥有本地托盘上的五分钟流转临时凭证。
- **存活不断流特性**：Token 寿命仅控制登录门禁（`API请求` 和 `前端UI的初次WebSocket握手`），但是已经建立起来的 Web UI 到终端的数据长流并不会在 24 小时一到后崩断。
- **5分钟更新阵痛期**：由于用户的电脑每 5 分钟换密码，如果他们遇到网络环境抖动正好断线并且错过了刚才的密码匹配期，需要在对话框里催要下最新的 6 位码再通过 `internal` 桥刷一遍。
