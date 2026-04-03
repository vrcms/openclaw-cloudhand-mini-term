/**
 * claude-driver.js
 * 
 * 基于"屏幕快照"策略驱动 claude CLI 的 PTY 控制器。
 * 引入 ClaudeParserLib.js 解决 ANSI 覆盖干扰问题。
 */

'use strict';

const pty   = require('node-pty');
const { ClaudeTerminalCanvas, ClaudeOutputParser } = require('./ClaudeParserLib');

// ─── 配置 ──────────────────────────────────────────────────────────────────
const IDLE_DEBOUNCE_MS     = 1500;    
const STARTING_DEBOUNCE_MS = 6000;   
const TASK_TIMEOUT_MS      = 600_000; 

// node-pty 在 Windows 上无法直接 spawn .cmd 文件，需通过 cmd.exe /c
const CLAUDE_CMD  = process.platform === 'win32' ? 'cmd.exe' : 'claude';
const CLAUDE_ARGS = process.platform === 'win32'
  ? ['/c', 'claude', ...(process.env.CLAUDE_ARGS || '').split(',').filter(Boolean)]
  : (process.env.CLAUDE_ARGS || '').split(',').filter(Boolean);

// ─── 状态 ──────────────────────────────────────────────────────────────────
let state     = 'STARTING'; // STARTING | IDLE | BUSY | DONE

let idleTimer    = null;
let taskResolveFn= null;
let taskRejectFn = null;
let taskTimer    = null;

// 使用大卷轴防止多行被截断
const PTY_COLS = 220;
const PTY_ROWS = 3000;
let globalCanvas = new ClaudeTerminalCanvas(PTY_COLS, PTY_ROWS);
let globalRawBuf = '';

// ─── PTY 启动 ──────────────────────────────────────────────────────────────
console.log('[Driver] 🚀 启动 claude ...');
console.log('[Driver] ExecPath:', CLAUDE_CMD);
console.log('[Driver] Args:', CLAUDE_ARGS);

const ptyProc = pty.spawn(CLAUDE_CMD, CLAUDE_ARGS, {
  name   : 'xterm-color',
  cols   : PTY_COLS,
  rows   : PTY_ROWS,
  cwd    : process.cwd(),
  env    : {
    ...process.env,
    TERM: 'xterm-256color',
  },
});

ptyProc.onExit(({ exitCode, signal }) => {
  console.log(`\n[Driver] PTY 进程退出，exitCode=${exitCode}, signal=${signal}`);
  process.exit(exitCode || 0);
});

ptyProc.onData((raw) => {
  globalRawBuf += raw;
  globalCanvas.write(raw);

  // Debug: continuously write visually parsed text to a file so we can view it later
  require('fs').writeFileSync('debug_live_canvas.txt', globalCanvas.getVisualText(), 'utf-8');

  // 1. 在发信后 WAITING_FOR_BUSY 阶段：我们需要寻找工作标识
  if (state === 'WAITING_FOR_BUSY') {
      const visualText = globalCanvas.getVisualText();
      if (ClaudeOutputParser.isBusy(visualText)) {
          state = 'BUSY';
          console.log('\n[DEBUG] 侦测到 Agent 进入 BUSY 状态');
      }
  }

  // 2. 正常防抖：只要继续有任何数据，就说明 Claude 还在绘制，重置定时器
  clearTimeout(idleTimer);
  let dtime = IDLE_DEBOUNCE_MS;
  if (state === 'STARTING') {
    dtime = STARTING_DEBOUNCE_MS;
  }
  idleTimer = setTimeout(onIdleDetected, dtime);
});

function onIdleDetected() {
  const visualText = globalCanvas.getVisualText();

  // 权限请求 — 仅在任务执行中才检测，避免 STARTING 阶段误判
  if ((state === 'BUSY' || state === 'WAITING_FOR_BUSY') && 
      ClaudeOutputParser.isPermissionRequest(visualText)) {
    handlePermissionRequest(visualText);
    return;
  }

  if (state === 'STARTING') {
    state = 'IDLE';
    console.log('[Driver] ✅ Claude 已就绪（检测到静默，进入 IDLE 状态）');
    runTasks();
    return;
  }

  // 只有在 BUSY 状态并进入静默期，才认为是任务完成
  if (state === 'BUSY') {
      
    // 二重校验，防止假静默
    if (ClaudeOutputParser.isDone(visualText)) {
        state = 'DONE';
        
        require('fs').writeFileSync('test_raw_buf.txt', visualText, 'utf-8');
        require('fs').writeFileSync('test_global_buf.txt', globalRawBuf, 'utf-8');

        // 使用 Parser 提取答案
        const replyText = ClaudeOutputParser.extractResponse(visualText);
        const replyLines = replyText.split('\n').filter(Boolean);

        console.log('\n[Driver] 📦 任务完成，清洗后的回复内容：');
        console.log('─'.repeat(40));
        console.log(replyText);
        console.log('─'.repeat(40) + '\n');

        state = 'IDLE';

        if (taskResolveFn) {
          clearTimeout(taskTimer);
          const fn = taskResolveFn;
          taskResolveFn = null;
          taskRejectFn  = null;
          fn(replyLines);
        }
    } else {
        // 假静默，可能还在执行或者思考过程中卡顿了
        console.log('\n[DEBUG] 仍在执行中，未检测到结束标记...', visualText.slice(-100).replace(/\n/g, '\\n'));
    }
  }
}

function handlePermissionRequest(visualText) {
  if (state === '_PERMISSION') return; 
  state = '_PERMISSION';

  const rawLines = visualText.split('\n');
  const cleanLines = [];
  
  for (let line of rawLines) {
    let tLine = line.trim();
    if (!tLine) continue;
    
    const noArtifacts = tLine.replace(/[\s─]/g, '');
    if (noArtifacts.includes('esctointerrupt') || noArtifacts.includes('?forshortcuts')) continue;
    if (tLine.includes('Claude Code has switched')) continue;
    
    if ((tLine.match(/[─╌━]/g) || []).length > 10) continue;
    if (tLine === '❯') continue;
    if (/^[▘▝▖▗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻◐◑◒◓·]+/.test(tLine)) continue;
    
    if (tLine.includes('Crunching…') || tLine.includes('Tempering…') || tLine.includes('Hatching…') || tLine.includes('Considering…') || tLine.includes('thinking')) continue;
    if (tLine.includes('Esc to cancel')) continue;

    cleanLines.push(tLine);
  }

  let resultLines = cleanLines.slice(-10);
  
  let startIdx = 0;
  for (let i = 0; i < resultLines.length; i++) {
    if (resultLines[i].includes('Do you want') || resultLines[i].includes('Allow Claude to')) {
      startIdx = Math.max(0, i - 2);
      break;
    }
  }
  
  const lastText = resultLines.slice(startIdx).join('\n');

  console.log('\n[Driver] ⚠️  检测到权限请求！');
  console.log('─'.repeat(60));
  console.log(lastText);
  console.log('─'.repeat(60));
  console.log('[Driver] 🔔 Claude 在等待你的授权，请手动处理或调用 sendPermission() 发送回应');

  require('fs').writeFileSync('debug_permission.txt', lastText, 'utf8');

  if (taskResolveFn) {
    clearTimeout(taskTimer);
    const fn = taskResolveFn;
    taskResolveFn = null;
    taskRejectFn  = null;
    fn({ type: 'permission_request', rawText: lastText });
  }
}

function sendMessage(text) {
  return new Promise((resolve, reject) => {
    if (state !== 'IDLE') {
      reject(new Error(`Claude 不在空闲状态，当前：${state}`));
      return;
    }

    taskResolveFn = resolve;
    taskRejectFn  = reject;

    taskTimer = setTimeout(() => {
      taskResolveFn = null;
      taskRejectFn  = null;
      reject(new Error('任务超时（超过 ' + TASK_TIMEOUT_MS / 1000 + 's）'));
    }, TASK_TIMEOUT_MS);

    // 重置全局画布，避免上次回复解析污染这次结果
    // 但不清空 globalRawBuf 用于 debug
    globalCanvas = new ClaudeTerminalCanvas(PTY_COLS, PTY_ROWS);

    state = 'WAITING_FOR_BUSY';

    console.log(`\n[Driver] 📤 发送消息：${text}`);
    ptyProc.write(text + '\r');
  });
}

function sendPermission() {
  state = 'BUSY';
  globalCanvas = new ClaudeTerminalCanvas(PTY_COLS, PTY_ROWS);
  console.log(`[Driver] 🔑 发送权限回应：以回车确认默认的 1. Yes`);
  ptyProc.write('\r');
}

async function sendAndWait(text) {
  let events = [];
  let reply = await sendMessage(text);
  events.push({ stage: 'initial_reply', data: reply });

  while (reply && reply.type === 'permission_request') {
    console.log('\n[Driver] 🚨 拦截到 Claude 请求权限：');
    console.log('【Claude选项提示】:\n' + reply.rawText);
    console.log('[Driver] ⚡ 自动选择 "y" 放行并继续等待任务完成...\n');
    
    events.push({ stage: 'permission_intercepted', screen_prompt: reply.rawText });

    reply = await new Promise((resolve, reject) => {
      taskResolveFn = resolve;
      taskRejectFn  = reject;

      taskTimer = setTimeout(() => {
        taskResolveFn = null;
        taskRejectFn  = null;
        reject(new Error('权限放行后等待超时（超过 ' + TASK_TIMEOUT_MS / 1000 + 's）'));
      }, TASK_TIMEOUT_MS);

      sendPermission();
    });
    
    events.push({ stage: 'post_permission_reply', data: reply });
  }

  return events;
}

async function runTasks() {
  try {
    console.log('[Driver] ⏳ 等待 Claude 初始化并进入 IDLE 空闲状态...');
    let waitCount = 0;
    while (state !== 'IDLE') {
      await sleep(1000);
      waitCount++;
      if (waitCount > 15) {
        throw new Error('Claude 启动等待 IDLE 超时');
      }
    }

    console.log('\n======================================================');
    console.log('【任务测试】向 Claude 提问：调查当前目录，输出简要报告');
    console.log('======================================================');
    
    const events = await sendAndWait('不要创建任何东西。请帮我调查一下当前目录结构，用中文回复一小段简要项目报告即可。');
    
    const fs = require('fs');
    fs.writeFileSync('reply5.json', JSON.stringify({ process_events: events }, null, 2), 'utf8');
    console.log('\n[Driver] ✅ 完成，结果已写入 reply5.json，结束当前流程。');

    process.exit(0);

  } catch (err) {
    console.error('[Driver] ❌ 任务执行出错：', err.message);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

process.on('SIGINT', () => {
  console.log('\n[Driver] 收到 Ctrl+C，退出...');
  ptyProc.kill();
  process.exit(0);
});
