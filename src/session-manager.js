const os = require('os');
const pty = require('node-pty');
const crypto = require('crypto');
const EventEmitter = require('events');

// PTY 会话管理器
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  // 创建新 PTY 会话
  createSession(options = {}) {
    // 使用随机 ID 防止跨重启碰撞
    const id = 's' + crypto.randomBytes(4).toString('hex');
    const defaultShell = process.env.DEFAULT_SHELL ||
      (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
    const shell = options.shell || defaultShell;
    const cwd = options.cwd || os.homedir();
    const cols = options.cols || 120;
    const rows = options.rows || 40;

    const env = { ...process.env };
    const shellArgs = [];

    // Windows 下添加 -NoLogo 参数减少启动输出
    if (os.platform() === 'win32' && shell.includes('powershell')) {
      shellArgs.push('-NoLogo');
    }

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    });

    // Windows 下自动设置 UTF-8 代码页
    if (os.platform() === 'win32') {
      ptyProcess.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r');
      ptyProcess.write('[Console]::InputEncoding = [System.Text.Encoding]::UTF8\r');
      ptyProcess.write('chcp 65001 > $null\r');
      ptyProcess.write('cls\r');
    }

    const session = {
      id,
      pty: ptyProcess,
      cwd,
      shell,
      createdAt: new Date().toISOString()
    };

    // PTY 输出事件
    ptyProcess.onData((data) => {
      this.emit('output', { sessionId: id, data });
    });

    // PTY 退出事件
    ptyProcess.onExit(({ exitCode }) => {
      this.emit('exit', { sessionId: id, exitCode });
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);
    this.emit('created', session);
    return session;
  }

  // 向 PTY 写入数据
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话 ${sessionId} 不存在`);
    session.pty.write(data);
  }

  // 调整 PTY 尺寸
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话 ${sessionId} 不存在`);
    session.pty.resize(cols, rows);
  }

  // 关闭指定会话
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话 ${sessionId} 不存在`);
    session.pty.kill();
    this.sessions.delete(sessionId);
    this.emit('closed', { sessionId });
  }

  // 获取会话列表
  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      cwd: s.cwd,
      shell: s.shell,
      createdAt: s.createdAt
    }));
  }

  // 销毁所有会话
  destroy() {
    for (const [, session] of this.sessions) {
      session.pty.kill();
    }
    this.sessions.clear();
  }
}

module.exports = SessionManager;
