/**
 * ClaudeParserLib.js
 * 
 * 基于对 ref_source_code/claude-code-haha 的反向工程实现。
 * 专门用于在 PTY 模式下从复杂的 ANSI 码流中过滤和筛选 Claude 的输出。
 */

const stripAnsi = require('strip-ansi');

class ClaudeTerminalCanvas {
    constructor(cols = 120, rows = 3000) {
        this.cols = cols;
        this.rows = rows;
        // 使用二维数组代替字符串，避免宽字符占位导致索引偏移
        this.buffer = Array.from({ length: rows }, () => new Array(cols).fill(' '));
        this.cursorX = 0;
        this.cursorY = 0;
    }

    write(data) {
        let i = 0;
        while (i < data.length) {
            const char = data[i];
            
            if (char === '\x1b' && data[i + 1] === '[') {
                let j = i + 2;
                let param = '';
                while (j < data.length && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3F) {
                    param += data[j];
                    j++;
                }
                const cmd = data[j];
                this._handleAnsi(param, cmd);
                i = j + 1;
                continue;
            }
            if (char === '\x1b' && data[i + 1] === ']') {
                let j = i + 2;
                while (j < data.length) {
                    if (data[j] === '\x07') { j++; break; }
                    if (data[j] === '\x1b' && data[j+1] === '\\') { j += 2; break; }
                    j++;
                }
                i = j;
                continue;
            }

            if (char === '\r') {
                this.cursorX = 0;
            } else if (char === '\n') {
                this._newLine();
            } else if (char === '\b') {
                this.cursorX = Math.max(0, this.cursorX - 1);
            } else if (data.charCodeAt(i) >= 32) {
                this._drawChar(char);
            }
            i++;
        }
    }

    _newLine() {
        this.cursorY++;
        if (this.cursorY >= this.rows) {
            this.buffer.shift();
            this.buffer.push(new Array(this.cols).fill(' '));
            this.cursorY = this.rows - 1;
        }
    }

    _drawChar(char) {
        if (this.cursorY >= this.rows) return;
        let charWidth = 1;
        if (/[\u4e00-\u9fa5\u3000-\u303F\uFF00-\uFFEF]/.test(char)) {
            charWidth = 2;
        }
        
        this.buffer[this.cursorY][this.cursorX] = char;
        if (charWidth === 2 && this.cursorX + 1 < this.cols) {
            this.buffer[this.cursorY][this.cursorX + 1] = null; // 宽字符占位
        }
        this.cursorX += charWidth;
        
        if (this.cursorX >= this.cols) {
            this.cursorX = 0;
            this._newLine();
        }
    }

    _handleAnsi(param, cmd) {
        const args = param.split(';').map(n => parseInt(n) || 0);
        const n = Math.max(1, args[0] || 1);
        switch (cmd) {
            case 'A': this.cursorY = Math.max(0, this.cursorY - n); break;
            case 'B': this.cursorY = Math.min(this.rows - 1, this.cursorY + n); break;
            case 'C': this.cursorX = Math.min(this.cols - 1, this.cursorX + n); break;
            case 'D': this.cursorX = Math.max(0, this.cursorX - n); break;
            case 'G': this.cursorX = Math.max(0, (args[0] || 1) - 1); break;
            case 'd': this.cursorY = Math.max(0, Math.min(this.rows - 1, (args[0] || 1) - 1)); break;
            case 'H':
            case 'f':
                this.cursorY = Math.max(0, Math.min(this.rows - 1, (args[0] || 1) - 1));
                this.cursorX = Math.max(0, Math.min(this.cols - 1, (args[1] || 1) - 1));
                break;
            case 'X':
                for (let c = 0; c < n && (this.cursorX + c) < this.cols; c++) {
                    this.buffer[this.cursorY][this.cursorX + c] = ' ';
                }
                break;
            case 'K':
                if (args[0] === 0 || param === '') {
                    this.buffer[this.cursorY].fill(' ', this.cursorX);
                } else if (args[0] === 1) {
                    this.buffer[this.cursorY].fill(' ', 0, this.cursorX + 1);
                } else if (args[0] === 2) {
                    this.buffer[this.cursorY].fill(' ');
                }
                break;
            case 'J':
                if (args[0] === 0 || param === '') {
                    this.buffer[this.cursorY].fill(' ', this.cursorX);
                    for (let r = this.cursorY + 1; r < this.rows; r++) {
                        this.buffer[r].fill(' ');
                    }
                } else if (args[0] === 2) {
                    for (let r = 0; r < this.rows; r++) {
                        this.buffer[r].fill(' ');
                    }
                }
                break;
        }
    }

    getVisualText() {
        return this.buffer.map(row => 
            row.map(c => c === null ? '' : c).join('').trimEnd()
        ).filter(line => line.length > 0).join('\n');
    }
}

class ClaudeOutputParser {
    static ANCHORS = {
        PROMPT_RAW: '❯',   // getVisualText 会 trimEnd 掉 \xa0，所以只匹配 ❯
        INTERRUPT: /esc(?:[\s─])to(?:[\s─])interrupt/i,
        SHORTCUTS: /\?(?:[\s─])for(?:[\s─])shortcuts/i,
        TOKENS: 'Tokens',
        COST: 'Cost'
    };

    static isBusy(rawText) {
        // isLoading = true 时，底部会渲染 esc to interrupt
        return this.ANCHORS.INTERRUPT.test(stripAnsi(rawText));
    }

    static isDone(renderedText) {
        // 完成的绝对标志：最后几行包含 ❯ 与无 esc to interrupt (注意：因为 ANSI move cursor 问题，空格可能变成 ─)
        const lines = renderedText.split('\n');
        const lastFewLines = lines.slice(-8).join('\n');
        return lastFewLines.includes(this.ANCHORS.PROMPT_RAW) && 
               !this.ANCHORS.INTERRUPT.test(lastFewLines);
    }

    static isPermissionRequest(renderedText) {
        const clean = stripAnsi(renderedText);
        // 保留权限请求匹配，这是基于 Terminal 捕获
        // 注意：ctrl+o to expand 是 tool use 折叠提示，不是权限请求，不要在此匹配
        const PERMISSION_RE = /requires\s*approval|want\s*to\s*proceed|esctocancel|\(y\/n\)|\[y\/n\]|allow\s*this|always\s*allow|1\.\s*yes|tabtoamend/i;
        return PERMISSION_RE.test(clean);
    }

    // 逆向滤网：取代以前的正向收集猜测，采用反向剥离不需要的组件
    static extractResponse(renderedText) {
        let lines = renderedText.split('\n');
        let promptIndex = -1;

        // Step 1: 寻找 Prompt 原点
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].includes(this.ANCHORS.PROMPT_RAW)) {
                promptIndex = i;
                break;
            }
        }

        if (promptIndex === -1) {
            // Fallback: 如果没有找到 prompt，大概率还在错误退出或极端情况下
            return stripAnsi(renderedText).replace(/\s+$/, '');
        }

        // Step 2: 剥除 Prompt 以及其下方的 Chrome Footer (比如 ? for shortcuts)
        lines = lines.slice(0, promptIndex);

        // Step 3: 向前剥离 Token 测算、Cost 测算、以及水平分隔线组件
        // 这些组件通常只出现在 Prompt 紧邻的上方
        let cutoffIndex = lines.length;
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
            const cleanLine = stripAnsi(lines[i]).trim();
            if (cleanLine.includes(this.ANCHORS.COST) || 
                cleanLine.includes(this.ANCHORS.TOKENS) || 
                cleanLine.match(/^[─━]+$/) || 
                cleanLine.match(/^[✻✢✶✽·*◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▘▝▖▗]/) ||
                cleanLine === '') {
                cutoffIndex = i;
            } else {
                // 遇到第一个非统计、非边框、非 spinner 的真实文本行，停止剥离
                break;
            }
        }
        lines = lines.slice(0, cutoffIndex);

        // Step 4: 清洗每行的 ANSI
        lines = lines.map(line => stripAnsi(line));

        // Step 5: 从第一个 ● (Assistant 回复标记) 开始裁剪，去掉用户输入回显和 tool use 摘要
        let assistantStart = lines.findIndex(line => line.trimStart().startsWith('●'));
        if (assistantStart > 0) {
            lines = lines.slice(assistantStart);
        }

        return lines.join('\n').trim();
    }
}

module.exports = {
    ClaudeTerminalCanvas,
    ClaudeOutputParser
};
