# CloudHand-Mini-Term (云手终端版)

> 基于 Tauri 2.x 的本地终端管理桌面应用，让远程 OpenClaw AI 智能体直接操控你的本地终端。

## 项目简介

CloudHand-Mini-Term 是一个专为 [OpenClaw](https://openclaw.ai) 设计的轻量级本地桌面应用。它在本地计算机上开放 WebSocket (WS/WSS) 服务，作为桥梁连接远程 AI 智能体与本地系统。通过集成真正的 PTY 支持，AI 可以像人类用户一样在高性能终端中执行命令并获取实时反馈。

## 技术栈

- **核心框架**: [Tauri 2.x](https://tauri.app/) (Rust 驱动，轻量且安全)
- **PTY 支持**: [portable-pty](https://github.com/wez/wezterm/tree/main/pty) (提供跨平台的真实伪终端支持)
- **终端渲染**: [xterm.js](https://xtermjs.org/) (行业标准的终端模拟器前端)
- **前端 UI**: 原生 JavaScript + HTML/CSS (保持极致的启动速度和资源占用)

## 核心功能

- **原生终端体验**：通过 `portable-pty` 提供完整的 shell 环境支持（Windows .exe）。
- **高性能渲染**：使用 `xterm.js` 在桌面窗口中实时展示命令执行过程。
- **本地 WS/WSS 服务**：在 `9876` 端口开放 WebSocket 服务，等待 OpenClaw 建立加密连接。
- **远程 CLI 操控**：允许远程 AI 发送指令、管理文件、执行脚本，并实时流式传输标准输出（stdout/stderr）。
- **安全隔离**：支持 Token 鉴权，确保只有授权的智能体能访问你的本地终端。

## 快速上手

### 1. 开发环境准备

确保你已安装 [Rust](https://www.rust-lang.org/) 环境和 Node.js。

```bash
npm install
```

### 2. 运行桌面应用

```bash
npm run tauri dev
```

### 3. 构建发布包 (Windows .exe)

```bash
npm run tauri build
```

## 架构原理

```
┌─────────────────────┐          ┌───────────────────────────────────┐
│   远程 OpenClaw     │          │         本地桌面应用 (Tauri)       │
│                     │  WS/WSS  │  ┌────────────┐  ┌──────────────┐ │
│  AI 智能体          │ <──────> │  │ WebSocket  │──│ portable-pty │ │
│      │              │          │  │  Server    │  │ (Shell Env)  │ │
│  发送 CLI 指令      │          │  └────────────┘  └──────┬───────┘ │
│      └──────────────┼──────────┼─────────────────────────▼─────────┤
└─────────────────────┘          │       xterm.js Terminal UI        │
                                 └───────────────────────────────────┘
```

## 安全警告

**重要提示**：此工具允许通过网络远程执行系统命令。请务必：
- 仅在受信任的网络环境中使用，不要将 `9876` 端口直接暴露在公网。
- 保护好你的 `apiToken`。
- 开启应用后，请随时监控终端窗口中的活动。

## 许可

MIT
