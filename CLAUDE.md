# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CloudHand-Mini-Term (云手终端版) — 基于 Tauri 2.x 的本地终端管理桌面应用，作为远程 OpenClaw AI 智能体与本地系统之间的桥梁。

## 技术栈

- **核心框架**: Tauri 2.x (Rust)
- **PTY 支持**: portable-pty (跨平台伪终端)
- **终端渲染**: xterm.js (前端终端模拟器)
- **前端**: 原生 JavaScript + HTML/CSS

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式运行
npm run tauri dev

# 构建发布包
npm run tauri build
```

## 架构概览

```
远程 OpenClaw AI          本地 Tauri 应用
     │                    ┌────────────┐  ┌──────────────┐
     │  WS/WSS (9876端口)  │ WebSocket  │──│ portable-pty │
     │ <────────────────> │  Server    │  │ (Shell Env)  │
     │                    └────────────┘  └──────┬───────┘
     │                    └───────────────────────┤
                               xterm.js Terminal UI
```

- 本地 WebSocket 服务在 `9876` 端口监听
- 通过 `portable-pty` 提供真实 shell 环境
- 使用 `xterm.js` 在前端渲染终端输出
- 支持 Token 鉴权

## 项目结构约定

- `src-tauri/` — Rust 后端代码（Tauri 应用核心）
- `src/` — 前端代码（HTML/CSS/JS）
- 按功能模块组织代码，前端保持原生 JS 以维持启动速度和低资源占用
