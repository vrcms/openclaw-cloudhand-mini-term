# Claude CLI 输出格式与状态特征规范 (PTY/ANSI 模式)

本文档定义了在 **非 JSON 模式** 下，通过 PTY 捕捉 Claude CLI 输出并进行状态识别的技术规范。

## 一、 核心状态视觉锚点 (Unicode)

Claude 在 TUI 模式下使用特定的符号作为状态指示器（参考源码 `src/constants/figures.ts`）：

| 状态类型 | 字符 | Unicode | 含义 | 匹配建议 (Regex) |
| :--- | :--- | :--- | :--- | :--- |
| **思考 (Thinking)** | `∴` | `\u2234` | 模型正在生成深度推理链 | `/\u2234 Thinking/` |
| **执行 (Working)** | `∙` | `\u2219` | 正在运行工具、搜索或读取文件 | `/\u2219 (Flowing|Running|Baking)/` |
| **回复 (Assistant)** | `●` | `\u25cf` | AI 正式回答的起始位置 | `/^\s*\u25cf/m` |
| **完成 (Idle)** | `❯` | `\u276f` | 出现 Prompt，等待输入 | `/\u276f\s*$/` |
| **分隔符 (Box)** | `━` / `─` | `\u2501` / `\u2500` | 状态栏与消息之间的水平分割线 | `/[\u2501\u2500]{10,}/` |
| **状态图标** | `✻` / `✢` | `\u273b` / `\u2722` | 加载动画的帧字符 | `/[\u273b\u2722\u2736\u2737]/` |

---

## 二、 渲染引擎底层逻辑 (MeasuredText & Cursor)

Claude 内部维护一个行数组模型，通过 ANSI 转义码进行增量更新。

### 1. 物理覆盖机制 (The Overwrite Logic)
Claude 频繁使用 `\x1b[A` (Cursor Up) 将光标移回之前的行进行重写。例如：将 `∴ Thinking` 覆盖为真正的回复。驱动程序必须处理此逻辑，否则缓冲区会堆积过时的碎片。

### 2. Grapheme 安全
匹配前必须剥离 ANSI 样式 (`strip-ansi`)，并注意 Unicode 代理对。

---

## 三、 React/Ink 组件的反向滤网重构

根据对 `ref_source_code` 的反向推导，Claude CLI 是基于 React 与 Ink 框架渲染到终端的组件树，我们不应使用正则表达式对文本内容“黑盒拆解”，而应该模拟对这几个已知组件的文本输出特征进行“自底向上逆向截断”。

### 1. 明确的组件脚印发现
- **PromptInputModeIndicator (提示符)**：
  源码实现 `t1 = <Text color={color} dimColor={isLoading}>{figures.pointer}&nbsp;</Text>;`
  因此，终端输出的真实提示符为：`❯\u00a0`（大于号与一个不换行空格，不要单纯匹配空格）。
  
- **PromptInputFooterLeftSide (提示快捷键脚注)**：
  这里有严格的 `isLoading` 判断机制。
  当 `isLoading === true` 时，必定输出 Spinner 的 `esc to interrupt` 组件。
  当 `isLoading === false`（空闲等待中）时，必定输出 `? for shortcuts`（无任务时）或其他 UI。

### 2. 完美的 IDLE/BUSY 状态机判据
判断执行结束（`isDone`）应当满足：
1. 取画布最后几行（比如后5行）。
2. 同时检测到 `❯\u00a0` 所在的输入焦点行。
3. **关键绝对条件**：该范围内绝对不包含 `esc to interrupt`（这代表 `isLoading` 为 false）。

### 3. 截断与净化的“洋葱模型”
当我们截获一块最终输出并要进行“提取”时，要对文本逆向进行以下步骤削减 UI 残留：
1. **定位原点**：从下往上找到最后一个出现 `❯\u00a0` 的行。
2. **剔除底部 Chrome**：将该行及其下方所有的行全部切除（丢掉 `? for shortcuts` 和边框）。
3. **剔除统计信息**：如果倒数剩余的行中含有 `Tokens` 与 `Cost` 表格，将其剔除（通常占用 4 行左右）。
4. **剔除多余的面包屑**：若顶部残卷了上一次对话或 `<Claude>` 的启动标题栏，也应剥离。

---

## 四、 理想捕捉逻辑 (代码实现建议)

```javascript
class ClaudeReverseFilter {
    // 检查完成态（绝对可靠）
    static isDone(renderedText) {
        const tailLines = renderedText.split('\n').slice(-5).join('\n');
        return tailLines.includes('❯\u00a0') && !tailLines.includes('esc to interrupt');
    }
    
    // 反向提取方法
    static extractCleanResponse(renderedText) {
        const lines = renderedText.split('\n');
        let promptIndex = -1;
        // Step 1: 寻找截断点（自底向上找 Prompt）
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].includes('❯\xa0')) {
                promptIndex = i;
                break;
            }
        }
        if (promptIndex === -1) return renderedText; // Fallback
        
        let contentLines = lines.slice(0, promptIndex);
        
        // Step 2: 剥离 Token 统计信息组件
        // ... (在遇到 ─ 分隔符或 Cost 时截短)
        
        return contentLines.join('\n').trim();
    }
}
```
