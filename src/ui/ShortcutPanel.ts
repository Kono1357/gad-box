/**
 * 快捷键面板（列表 + 自定义 + 冲突检测）。
 *
 * ────────────────────────────────────────────────────────────
 * 与已有的 `src/ui/ShortcutHelp.ts` 是什么关系
 * ────────────────────────────────────────────────────────────
 * `ShortcutHelp` 是**只读速查表**：它把 `SHORTCUT_GROUPS` 渲染成一堆 `<details>`，
 * 开合由 Engine 分发（它自己只认 Esc）。它的能力边界很明确 —— 改不了键、搜不了、
 * 也发现不了"同一个键被绑了两次"。本轮要做的是可自定义 + 冲突检测 + 搜索 + 恢复默认，
 * 那已经不是"给它加两个按钮"能覆盖的了（还得分组折叠状态、捕获态、冲突横幅、存储迁移），
 * 所以在**新文件**里做完整版；替换方式见报告与 `docs/snippets/m5-ui.html`。
 *
 * 这里刻意**没有**去 import 或继承 `ShortcutHelp`：
 * 两个类的键位表真源不同（那份是人手写的展示文本，这份是"可绑定"的唯一真源），
 * 继承只会把两份数据绑死，改一份另一份立刻对不上。
 *
 * ────────────────────────────────────────────────────────────
 * 键位是怎么表示的
 * ────────────────────────────────────────────────────────────
 * 内部一律用**规范键位串**（canonical spec）：
 *   - 修饰键按固定顺序在前：`Ctrl+Shift+Alt+Z`（顺序不随用户按下的先后变）；
 *   - 主键用 `KeyboardEvent.code` 映射来的记号：字母数字直接用字符（`Z` / `4`），
 *     功能键 `F1`，符号用它在 US 布局上的**未按 Shift** 形态（`[`、`]`、`` ` ``、`,`、`.`、`/`、`-`、`=`）；
 *   - 方向键、空格、回车等在表里各有名字（`ArrowLeft` / `Space` / `Enter`），
 *     显示时再由 `displayKeySpec()` 变成 `←` / `空格` / `回车`。
 *
 * 为什么用 `code` 而不是 `key`：`key` 会跟着输入法、大小写、Shift 变
 * （按 Shift+Z 时 `key` 是 `'Z'` 还是 `'z'` 取决于浏览器），拿它当绑定键会飘；
 * `code` 是物理位置，稳定。副作用是**不同键盘布局的符号位置可能不同**（AZERTY 等），
 * 这点在报告里明确列为已知限制。
 *
 * ────────────────────────────────────────────────────────────
 * 冲突：报告，但绝不静默覆盖
 * ────────────────────────────────────────────────────────────
 * `setBinding()` 撞到别人的键时**直接拒绝**并给出中文原因（哪个动作占了），
 * 玩家的原绑定一个字节都不变 —— 静默覆盖的后果是"我明明改了 A，B 却不响了"，
 * 这种 bug 玩家根本查不出来。
 * 存储里的历史数据（手改过 localStorage、或旧版本写进去的）可能自带冲突，
 * 那种情况不丢数据，而是让 `conflicts()` 把它列出来、在面板顶上标红。
 *
 * 本文件不 import Three.js / Rapier / Engine：只碰 DOM 与 localStorage，
 * 因此 Node 里也能构造（container 传 null）并断言逻辑。
 */

/** 面板里用的分组顺序（也是渲染顺序） */
export const SHORTCUT_GROUPS: readonly string[] = ['工具', '相机', '编辑', '时间', '面板'];

export interface ShortcutDef {
  id: string;
  label: string;
  group: string;
  defaultKeys: string;
}

/**
 * 默认快捷键表 —— **这是可绑定键位的唯一真源**。
 *
 * 每一条都对着 `src/core/Engine.ts` 的 `handleShortcut()`（以及
 * `render/GodCameraControls.ts` 的 `F` 复位、`input/InputSystem.ts` 的 WASD 按键状态）抄下来的，
 * 不是照着旧速查表 `ShortcutHelp.ts` 抄的 —— 那份有几处已经过期
 * （例如它写"Tab = 编辑/观察模式切换"，而 Engine 里 Tab 早就改成"切候选点"、模式切换归 V）。
 *
 * 两个**刻意**的取舍：
 *
 * 1. **数字键只登记"切工具"这一条**。Engine 里 `1~9 / 0 / - / =` 在地形工具下被
 *    笔刷模式复用（`handleShortcut` 的 default 分支），也就是同一个物理键在两处生效。
 *    如果这里两条都登记，默认表就会自己和自己"冲突"（同一个键 × 两个 id），
 *    把真正需要报的冲突淹没掉。所以笔刷模式那 12 档不在这里登记，而是写成一条提示
 *    （见下面的 `brush-mode-note`），等按键上下文分发（按工具切键表）做好了再登记。
 * 2. **Q/E 也复用**：建筑工具下是"旋转选中"，其它工具下是相机升降。
 *    这里登记成相机升降（常态），标签里写明建筑工具下兼作旋转。
 */
export const DEFAULT_SHORTCUTS: readonly ShortcutDef[] = [
  // ---------------------------------------------------------------- 工具
  { id: 'tool-terrain', label: '切换到地形笔刷', group: '工具', defaultKeys: '1' },
  { id: 'tool-building', label: '切换到建筑放置', group: '工具', defaultKeys: '2' },
  { id: 'tool-select', label: '切换到选择工具', group: '工具', defaultKeys: '3' },
  { id: 'tool-fluid', label: '切换到流体工具', group: '工具', defaultKeys: '4' },
  { id: 'tool-sand', label: '切换到沙土工具', group: '工具', defaultKeys: '5' },
  { id: 'mode-toggle', label: '切换编辑 / 观察模式', group: '工具', defaultKeys: 'V' },
  { id: 'snap-anchors', label: '开关落点吸附对齐', group: '工具', defaultKeys: 'G' },
  { id: 'candidate-next', label: '切到下一个候选落点', group: '工具', defaultKeys: 'Tab' },
  { id: 'candidate-prev', label: '切到上一个候选落点', group: '工具', defaultKeys: 'Shift+Tab' },
  { id: 'brush-shape-prev', label: '笔刷形状（建筑工具下为候选点）上一个', group: '工具', defaultKeys: '[' },
  { id: 'brush-shape-next', label: '笔刷形状（建筑工具下为候选点）下一个', group: '工具', defaultKeys: ']' },
  { id: 'confirm-placement', label: '确认放置', group: '工具', defaultKeys: 'Enter' },
  { id: 'cancel', label: '取消放置 / 清空选择', group: '工具', defaultKeys: 'Escape' },
  { id: 'pickup', label: '拿起 / 放下选中物体', group: '工具', defaultKeys: 'Space' },

  // ---------------------------------------------------------------- 相机
  { id: 'cam-forward', label: '相机向前', group: '相机', defaultKeys: 'W' },
  { id: 'cam-left', label: '相机向左', group: '相机', defaultKeys: 'A' },
  { id: 'cam-back', label: '相机向后', group: '相机', defaultKeys: 'S' },
  { id: 'cam-right', label: '相机向右', group: '相机', defaultKeys: 'D' },
  { id: 'cam-down', label: '相机下降（建筑工具下兼作左转）', group: '相机', defaultKeys: 'Q' },
  { id: 'cam-up', label: '相机上升（建筑工具下兼作右转）', group: '相机', defaultKeys: 'E' },
  {
    id: 'cam-boost',
    label: '按住加速移动（按住类按键，不是按一下）',
    group: '相机',
    defaultKeys: 'Shift',
  },
  { id: 'camera-reset', label: '复位相机', group: '相机', defaultKeys: 'F' },

  // ---------------------------------------------------------------- 编辑
  { id: 'undo', label: '撤销', group: '编辑', defaultKeys: 'Ctrl+Z' },
  { id: 'redo', label: '重做', group: '编辑', defaultKeys: 'Ctrl+Y' },
  { id: 'redo-alt', label: '重做（备用键）', group: '编辑', defaultKeys: 'Ctrl+Shift+Z' },
  { id: 'save', label: '保存到本地', group: '编辑', defaultKeys: 'Ctrl+S' },
  { id: 'import', label: '导入存档 JSON', group: '编辑', defaultKeys: 'Ctrl+O' },
  { id: 'duplicate', label: '复制选中', group: '编辑', defaultKeys: 'Ctrl+D' },
  { id: 'select-all', label: '全选', group: '编辑', defaultKeys: 'Ctrl+A' },
  { id: 'group', label: '成组', group: '编辑', defaultKeys: 'Ctrl+G' },
  { id: 'ungroup', label: '解散组', group: '编辑', defaultKeys: 'Ctrl+Shift+G' },
  { id: 'prefab', label: '保存为预制件', group: '编辑', defaultKeys: 'Ctrl+P' },
  { id: 'blueprint', label: '导出蓝图', group: '编辑', defaultKeys: 'Ctrl+B' },
  { id: 'mirror', label: '镜像复制', group: '编辑', defaultKeys: 'Ctrl+M' },
  { id: 'delete', label: '删除选中', group: '编辑', defaultKeys: 'Delete' },
  // ⚠ 这里**故意没有**「重新生成地形」。
  // 接线时（M5 第 5 批）核对过：Engine 的 handleShortcut 里那段 `if (ctrl)` 分支对
  // `Ctrl+Shift+R` 直接 return，所以这个动作**从来没能被触发过**（Ctrl 组合走的是另一个 switch）。
  // 而重建地形是不可逆的、表里也写着"需二次确认"，顺手把它接活等于新增一个没有确认对话框的
  // 破坏性快捷键。按"以引擎现有行为为准"的约定，这条绑定被删掉（按键仍然什么都不做），
  // `Engine.regenerateTerrain()` 留成公开方法供控制台 / 将来的菜单入口使用。
  { id: 'nudge-left', label: '选中物体向左微调一格', group: '编辑', defaultKeys: 'ArrowLeft' },
  { id: 'nudge-right', label: '选中物体向右微调一格', group: '编辑', defaultKeys: 'ArrowRight' },
  { id: 'nudge-up', label: '选中物体向上一格', group: '编辑', defaultKeys: 'ArrowUp' },
  { id: 'nudge-down', label: '选中物体向下一格', group: '编辑', defaultKeys: 'ArrowDown' },
  { id: 'nudge-far', label: '选中物体 Z 轴退一格', group: '编辑', defaultKeys: 'Shift+ArrowUp' },
  { id: 'nudge-near', label: '选中物体 Z 轴进一格', group: '编辑', defaultKeys: 'Shift+ArrowDown' },
  { id: 'rotate-left', label: '绕 Y 轴微调旋转（逆时针）', group: '编辑', defaultKeys: ',' },
  { id: 'rotate-right', label: '绕 Y 轴微调旋转（顺时针）', group: '编辑', defaultKeys: '.' },

  // ---------------------------------------------------------------- 时间
  { id: 'pause', label: '暂停 / 播放', group: '时间', defaultKeys: 'P' },
  { id: 'step', label: '单步推进 1/60 秒', group: '时间', defaultKeys: 'N' },
  { id: 'rewind-back', label: '回溯一帧', group: '时间', defaultKeys: 'R' },
  { id: 'rewind-forward', label: '前进一帧', group: '时间', defaultKeys: 'Shift+R' },

  // ---------------------------------------------------------------- 面板
  { id: 'help', label: '打开 / 关闭本快捷键面板', group: '面板', defaultKeys: 'F1' },
  { id: 'help-alt', label: '打开 / 关闭本快捷键面板（? 键）', group: '面板', defaultKeys: 'Shift+/' },
  // M5 第 3 批接入帮助中心时补的一条：H 在接线时核对过没被 Engine 的
  // handleKeyDown（相机）与 handleShortcut（其它动作）占用，所以是安全的空位
  { id: 'help-center', label: '打开 / 收起帮助中心', group: '面板', defaultKeys: 'H' },
  { id: 'map-menu', label: '打开 / 关闭参考地图菜单', group: '面板', defaultKeys: 'M' },
  { id: 'combo-panel', label: '组合面板', group: '面板', defaultKeys: 'K' },
  { id: 'tutorial', label: '教学：开始 / 退出', group: '面板', defaultKeys: 'J' },
  { id: 'physics-panel', label: '物理框架面板', group: '面板', defaultKeys: 'F2' },
  { id: 'chunk-borders', label: '区块边界线框', group: '面板', defaultKeys: 'B' },
  { id: 'rebuild-mesh', label: '重建全部区块网格', group: '面板', defaultKeys: 'Shift+B' },
  { id: 'wireframe', label: '地形线框模式', group: '面板', defaultKeys: '`' },
];

/** 快捷键绑定的存储键（`gad-box-` 前缀按本批次任务书） */
export const SHORTCUT_STORAGE_KEY = 'gad-box-shortcuts-v1';

/** 键位捕获时的提示语（面板与断言共用，避免两处文案写歪） */
export const CAPTURE_HINT = '按下新键…（Esc 取消）';

/** 冲突严重级别：`error` = 同一个键绑了两个动作；`warn` = 修饰键前缀重叠（见 detectConflicts） */
export type ConflictSeverity = 'error' | 'warn';

export interface ShortcutConflict {
  severity: ConflictSeverity;
  /** 规范键位串 */
  keys: string;
  /** 涉及的动作 id */
  ids: string[];
  /** 直接给玩家看的中文说明 */
  message: string;
}

export interface ShortcutPanelOptions {
  /** 绑定表变化（改键 / 恢复默认 / 存储迁移）时回调，参数是**副本** */
  onChange?: (bindings: Record<string, string>) => void;
  /** 存储键，默认 SHORTCUT_STORAGE_KEY（断言里换成临时键，避免污染真实数据） */
  storageKey?: string;
}

/** 只有 code 才能稳定表达的键。字母/数字/功能键在下面用循环生成，免得手写几十条漏掉 */
const NAMED_CODES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
};

/** 修饰键各自的 code → 记号。单独处理的原因见 keySpecFromEvent（按住 Shift 加速要能绑） */
const MODIFIER_CODES: Record<string, string> = {
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
};

/** `KeyboardEvent.code` → 规范记号 */
const CODE_TO_TOKEN: Record<string, string> = (() => {
  const table: Record<string, string> = { ...NAMED_CODES };
  // 字母与数字：KeyA~KeyZ / Digit0~Digit9
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    table[`Key${letter}`] = letter;
  }
  for (let i = 0; i <= 9; i += 1) table[`Digit${i}`] = String(i);
  for (let i = 1; i <= 12; i += 1) table[`F${i}`] = `F${i}`;
  return table;
})();

/** 记号 → 特殊形态的规范串（Shift+符号）。玩家看到 `?` 比看到 `Shift+/` 更像人话 */
const SHIFTED_GLYPHS: Record<string, string> = {
  '?': 'Shift+/',
  '~': 'Shift+`',
  ':': 'Shift+;',
  '"': "Shift+'",
  '<': 'Shift+,',
  '>': 'Shift+.',
  '{': 'Shift+[',
  '}': 'Shift+]',
  '!': 'Shift+1',
  '@': 'Shift+2',
  '#': 'Shift+3',
  $: 'Shift+4',
  '%': 'Shift+5',
  '^': 'Shift+6',
  '&': 'Shift+7',
  '*': 'Shift+8',
  '(': 'Shift+9',
  ')': 'Shift+0',
  _: 'Shift+-',
  '+': 'Shift+=',
  '|': 'Shift+\\',
};

/** 中文/别名 → 规范记号（玩家手输的文本、以及旧文档里的写法都要认） */
const TOKEN_ALIASES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Ctrl',
  super: 'Ctrl',
  win: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  '空格': 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  '回车': 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  '退格': 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  '删除': 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  '上': 'ArrowUp',
  '下': 'ArrowDown',
  '左': 'ArrowLeft',
  '右': 'ArrowRight',
};

const MODIFIER_ORDER: readonly string[] = ['Ctrl', 'Shift', 'Alt'];

/** 显示用替换表：规范串 → 玩家看得懂的写法 */
const DISPLAY_TOKENS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: '空格',
  Escape: 'Esc',
  Shift: 'Shift（按住）',
};

/** 整串替换表：带 Shift 的符号直接显示成它打出来的那个字符，比 `Shift+/` 直观 */
const DISPLAY_SPECS: Record<string, string> = {
  'Shift+/': '?',
  'Shift+[': '{',
  'Shift+]': '}',
  'Shift+`': '~',
  'Shift+,': '<',
  'Shift+.': '>',
  'Shift+;': ':',
};

/**
 * 把 `KeyboardEvent` 里的按键信息转成规范键位串；转不出来（修饰键以外的未知键）返回 null。
 *
 * 三处刻意的处理：
 * 1. **按下的就是修饰键本身时，只返回修饰键**（`Shift` 而不是 `Shift+Shift`）——
 *    按下 ShiftLeft 时 `ev.shiftKey` 已经是 true 了，不特判的话规范串会长成 `Shift+Shift`，
 *    于是"按住加速"这类按住型绑定永远配不上；
 * 2. `metaKey` 不在入参里：Engine 里一直把 mac 的 Cmd 当 Ctrl 用（`ev.ctrlKey || ev.metaKey`），
 *    所以**调用方应该把 metaKey 并进 ctrlKey 再传进来**（接线片段里就是这么写的）；
 * 3. 认不出来的 code（媒体键、输入法键、笔记本的 Fn 组合）返回 null，宁可不认也别乱绑。
 */
export function keySpecFromEvent(event: {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  const modifier = MODIFIER_CODES[event.code];
  if (modifier) return modifier;

  const token = CODE_TO_TOKEN[event.code];
  if (!token) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(token);
  return parts.join('+');
}

/** 是否是"按住型"键位（只有一个修饰键）。按住型和普通键的处理方式不同 */
export function isHoldSpec(spec: string): boolean {
  return MODIFIER_ORDER.includes(spec);
}

/**
 * 把玩家输入的文本（或任意来源的字符串）规范化成键位串；不合法返回 null。
 * 容错：`+` 两侧的空格、大小写、`Esc`/`Esc 键` 之类的别名、中文键名、Shift 符号（`?` → `Shift+/`）。
 */
export function normalizeKeySpec(spec: string): string | null {
  if (typeof spec !== 'string') return null;
  const trimmed = spec.trim();
  if (trimmed === '') return null;

  // 单字符的 Shift 形态（? ~ : …）先展开成 Shift+X
  const shifted = SHIFTED_GLYPHS[trimmed];
  const source = shifted ?? trimmed;

  const rawParts = source.split('+');
  const tokens: string[] = [];
  for (const rawPart of rawParts) {
    const part = rawPart.trim();
    if (part === '') {
      // 允许 "Ctrl + Z" 这种写法：空片段只在中间是由空格引起的，直接忽略；
      // 但 "Ctrl+" 这种尾随加号是真的写错了 —— 结果一样是空片段，这里统一按"忽略"处理，
      // 因为最终还要过一遍下面的合法性检查（少一个主键就会被拒）。
      continue;
    }
    const lower = part.toLowerCase();
    const alias = TOKEN_ALIASES[lower] ?? TOKEN_ALIASES[part];
    if (alias) {
      tokens.push(alias);
      continue;
    }
    // 单字符：字母统一大写；数字/符号原样
    if (part.length === 1) {
      tokens.push(part.toUpperCase());
      continue;
    }
    // F1~F12
    if (/^f([1-9]|1[0-2])$/i.test(part)) {
      tokens.push(part.toUpperCase());
      continue;
    }
    // 未知的多字符记号（比如 "Foo"）—— 拒绝，别把垃圾存进 localStorage
    return null;
  }

  if (tokens.length === 0) return null;

  const modifiers = MODIFIER_ORDER.filter((name) => tokens.includes(name));
  const keys = tokens.filter((name) => !MODIFIER_ORDER.includes(name));
  if (keys.length > 1) return null; // 一个绑定只能有一个主键
  if (keys.length === 0) {
    // 只有修饰键：允许，但只能有一个（"Ctrl+Shift" 这种组合按住型没有意义）
    return modifiers.length === 1 ? modifiers[0] : null;
  }

  if (modifiers.length === 0) {
    // 无修饰键时主键要认得出来：单字符或 F1~F12 已在上面放行，其余（如 "Foo"）不会走到这里
    return keys[0];
  }
  return [...modifiers, keys[0]].join('+');
}

/** 规范键位串 → 界面显示文本（`Shift+/` → `?`，`ArrowLeft` → `←`） */
export function displayKeySpec(spec: string): string {
  const whole = DISPLAY_SPECS[spec];
  if (whole) return whole;
  const parts = spec.split('+');
  const last = parts[parts.length - 1];
  const shown = DISPLAY_TOKENS[last] ?? last;
  const head = parts.slice(0, -1);
  return [...head, shown].join('+');
}

/** 输入的焦点是否在"正在打字"的地方 */
function isTypingElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return (el as { isContentEditable?: boolean }).isContentEditable === true;
}

/**
 * 扫出一张绑定表里的冲突。
 *
 * 两类：
 * - `error`：同一个规范键位串被两个动作占用（这是真正的功能失灵，必须报）；
 * - `warn`：**修饰键前缀重叠** —— 某个动作绑的是按住型修饰键（`Shift`），
 *   而另一个动作绑了 `Shift+X`。严格说它们不是一个键，但玩家先按住 Shift 再按 X 时，
 *   两个动作都会被触发一次。默认表里就有这么一对（`cam-boost` = Shift、
 *   `candidate-prev` = Shift+Tab），这是**已知且可接受**的：加快捷键面板/切候选点
 *   时多按一下 Shift 本来就没有副作用。所以它是 warn 而不是 error，
 *   在界面上用一句提示说明，而不是挡着不让用。
 *
 * 纯函数：不碰 DOM / 存储，所以断言里可以直接喂人造冲突进去。
 */
export function detectConflicts(bindings: Record<string, string>): ShortcutConflict[] {
  const bySpec = new Map<string, string[]>();
  for (const [id, spec] of Object.entries(bindings)) {
    const list = bySpec.get(spec);
    if (list) list.push(id);
    else bySpec.set(spec, [id]);
  }

  const labelOf = (id: string): string => DEFAULT_SHORTCUTS.find((def) => def.id === id)?.label ?? id;
  const result: ShortcutConflict[] = [];

  for (const [spec, ids] of bySpec) {
    if (ids.length < 2) continue;
    result.push({
      severity: 'error',
      keys: spec,
      ids: [...ids],
      message: `「${displayKeySpec(spec)}」同时绑给了 ${ids.map((id) => `「${labelOf(id)}」`).join(' 和 ')}，按下去只会执行第一个`,
    });
  }

  // 修饰键前缀重叠
  const holdSpecs = [...bySpec.keys()].filter((spec) => isHoldSpec(spec));
  for (const hold of holdSpecs) {
    for (const spec of bySpec.keys()) {
      if (spec === hold) continue;
      if (!spec.startsWith(`${hold}+`)) continue;
      result.push({
        severity: 'warn',
        keys: spec,
        ids: [...(bySpec.get(hold) ?? []), ...(bySpec.get(spec) ?? [])],
        message: `「${displayKeySpec(spec)}」会先经过按住型键位「${displayKeySpec(hold)}」，两条会同时触发（默认就有一处，一般无副作用）`,
      });
    }
  }

  return result;
}

/** 读整张绑定表；任何异常都当成"没存过" */
function readStoredBindings(storageKey: string): Record<string, string> | null {
  try {
    // 守卫在 try 里面：禁用站点数据时读 localStorage 属性本身就会抛（兼容性审计 R1）
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[id] = value;
    }
    return out;
  } catch {
    // JSON 坏了、localStorage 被禁用都会走到这里：当作"没有自定义"，用默认表
    return null;
  }
}

/** 写整张绑定表。返回是否写成功（写不进去时内存里的绑定照常生效） */
function writeStoredBindings(storageKey: string, bindings: Record<string, string>): boolean {
  try {
    // 同 readStoredBindings：守卫要在 try 里面（R1）
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(storageKey, JSON.stringify(bindings));
    return true;
  } catch {
    return false;
  }
}

/** 删掉存储项（恢复默认时用）。清掉而不是写一份默认表：以后默认键位改了，玩家才跟得上 */
function clearStoredBindings(storageKey: string): void {
  try {
    // 同 readStoredBindings：守卫要在 try 里面（R1）
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(storageKey);
  } catch {
    // 删不掉也不能影响"内存里已经恢复默认"这件事
  }
}

/** 建节点的小工具：颜色全部走变量（没有变量时用兜底值），不去碰 style.css */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 面板自己的内联样式表（不能改 style.css，所以全部内联） */
const STYLE = {
  overlay: {
    position: 'fixed',
    inset: '0',
    display: 'none',
    zIndex: '60',
    background: 'rgba(6, 9, 12, 0.82)',
    padding: '16px',
    overflow: 'auto',
  },
  card: {
    maxWidth: '760px',
    margin: '0 auto',
    background: 'var(--panel, #141a21)',
    color: 'var(--text, #d8e2ea)',
    border: '1px solid var(--panel-border, #2b3640)',
    borderRadius: '6px',
    padding: '12px 14px',
  },
  header: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' },
  title: { flex: '1', fontSize: '15px' },
  input: {
    flex: '1 1 160px',
    minWidth: '120px',
    padding: '4px 6px',
    background: 'rgba(10, 13, 16, 0.9)',
    color: 'var(--text, #d8e2ea)',
    border: '1px solid var(--panel-border, #2b3640)',
    borderRadius: '4px',
  },
  button: {
    padding: '4px 8px',
    cursor: 'pointer',
    background: 'rgba(24, 30, 36, 0.9)',
    color: 'var(--text, #d8e2ea)',
    border: '1px solid var(--panel-border, #2b3640)',
    borderRadius: '4px',
  },
  banner: {
    margin: '6px 0',
    padding: '6px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    lineHeight: '1.5',
    border: '1px solid',
  },
  group: { margin: '10px 0 4px', color: 'var(--text-dim, #8b9aa8)', fontSize: '12px' },
  row: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    padding: '3px 0',
    borderBottom: '1px dashed rgba(127, 127, 127, 0.25)',
  },
  rowConflict: { borderLeft: '3px solid var(--danger, #ff6b5a)', paddingLeft: '6px' },
  kbd: {
    minWidth: '92px',
    textAlign: 'left',
    padding: '2px 6px',
    cursor: 'pointer',
    font: 'inherit',
    background: 'rgba(10, 13, 16, 0.9)',
    color: 'var(--accent, #7fd06a)',
    border: '1px solid var(--panel-border, #2b3640)',
    borderRadius: '4px',
  },
  label: { flex: '1', fontSize: '12px' },
} satisfies Record<string, Partial<CSSStyleDeclaration>>;

/**
 * 快捷键面板。
 *
 * 用法（上层侧）：
 * ```ts
 * const shortcuts = new ShortcutPanel(document.getElementById('shortcut-panel'), {
 *   onChange: (bindings) => console.log(bindings),
 * });
 * // 引擎分发：
 * const id = shortcuts.match(ev);   // ev: 把 metaKey 并进 ctrlKey
 * if (id === 'undo') engine.undo();
 * ```
 */
export class ShortcutPanel {
  private readonly container: HTMLElement | null;
  private readonly onChange: ((bindings: Record<string, string>) => void) | undefined;
  private readonly storageKey: string;
  private readonly defaults: Record<string, string> = {};

  /** 当前绑定（id → 规范键位串） */
  private current: Record<string, string> = {};
  /** 规范键位串 → id 的反查表。每次改动重建，match() 只查表不做遍历 */
  private reverse = new Map<string, string>();

  private capturingId: string | null = null;
  private searchQuery = '';
  private disposed = false;
  private statusText = '';
  private statusTone: 'ok' | 'error' = 'ok';

  // 面板节点（container 为 null 时全部为 null，逻辑部分照常工作）
  private overlay: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  /** 骨架节点（搜索框 / 两个按钮 / 遮罩）上的监听，只在 buildShell 时挂一次 */
  private readonly boxListeners: { el: HTMLElement; type: string; listener: EventListener }[] = [];
  /**
   * 列表行上的监听。
   *
   * 单独一个数组的原因：列表每次渲染都是**整棵重建**（搜索、改键、冲突变化都要重画），
   * 行节点被丢掉时它的监听本来就没人能触发了，还留在 boxListeners 里只会让数组无限长
   * ——所以每次重画前把这个数组清空，dispose 时也不必逐条摘（节点已经不在文档里）。
   */
  private listListeners: { el: HTMLElement; type: string; listener: EventListener }[] = [];

  constructor(container: HTMLElement | null, options: ShortcutPanelOptions = {}) {
    this.container = container;
    this.onChange = options.onChange;
    this.storageKey = options.storageKey ?? SHORTCUT_STORAGE_KEY;

    for (const def of DEFAULT_SHORTCUTS) this.defaults[def.id] = def.defaultKeys;
    this.current = { ...this.defaults };
    this.loadFromStorage();
    this.rebuildReverse();

    this.render();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', this.handleWindowKeyDown);
    }
  }

  // ---------------------------------------------------------------- 数据

  /** 当前绑定表（副本：外部拿不到内部引用，改不动内部状态） */
  get bindings(): Record<string, string> {
    return { ...this.current };
  }

  /** 默认绑定表（副本） */
  get defaultsTable(): Record<string, string> {
    return { ...this.defaults };
  }

  /** 面板是否打开（没有 DOM 时恒为 false） */
  get isOpen(): boolean {
    return this.overlay !== null && this.overlay.style.display !== 'none';
  }

  /** 当前正在等待按键的动作 id；没有在捕获时为 null */
  get capturing(): string | null {
    return this.capturingId;
  }

  /** 扫一遍当前绑定表的冲突 */
  conflicts(): ShortcutConflict[] {
    return detectConflicts(this.current);
  }

  /**
   * 改一条绑定。
   *
   * 返回 `{ ok: false, reason }` 的三种情况，全部给中文原因：
   * - 没有这个动作 id；
   * - 键位串不合法；
   * - **和别人撞了**（此时原绑定完全不动 —— 允许"静默覆盖"等于埋雷，见文件头）。
   */
  setBinding(id: string, keys: string): { ok: boolean; reason?: string } {
    if (this.disposed) return { ok: false, reason: '面板已销毁，改键被忽略' };
    if (!(id in this.defaults)) return { ok: false, reason: `没有这个动作：${id}` };

    const spec = normalizeKeySpec(keys);
    if (!spec) {
      return {
        ok: false,
        reason: `认不出「${keys}」这个键位；支持字母 / 数字 / F1~F12 / 空格等具名键，前面可加 Ctrl、Shift、Alt`,
      };
    }

    const occupant = this.findOccupant(spec, id);
    if (occupant) {
      return {
        ok: false,
        reason: `「${displayKeySpec(spec)}」已经被「${occupant}」占用；原绑定未改动 —— 请先改掉那一条，或换一个键`,
      };
    }

    this.current[id] = spec;
    this.rebuildReverse();
    this.persist();
    this.render();
    this.onChange?.(this.bindings);
    return { ok: true };
  }

  /** 恢复全部默认键位（同时清掉存储，之后默认表升级玩家也能跟上） */
  resetAll(): void {
    if (this.disposed) return;
    this.current = { ...this.defaults };
    this.rebuildReverse();
    clearStoredBindings(this.storageKey);
    this.render();
    this.onChange?.(this.bindings);
  }

  /**
   * 把浏览器键盘事件映射成动作 id；没绑到 / 在输入框里打字时返回 `null`。
   *
   * **必须忽略输入框**：玩家在搜索框里打 `j`，如果这里照旧匹配，就会顺手开始教学、
   * 或者删掉选中的东西。判据是 `document.activeElement`（而不是 `event.target`）——
   * 事件是挂在 window 上的，target 在捕获阶段过后不一定还是输入框。
   */
  match(event: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
    if (this.disposed) return null;
    if (typeof document !== 'undefined' && isTypingElement(document.activeElement)) return null;
    const spec = keySpecFromEvent(event);
    if (!spec) return null;
    return this.reverse.get(spec) ?? null;
  }

  /** 查某个键位被谁占了（排除 excludeId 自己）；返回那个动作的中文标签 */
  private findOccupant(spec: string, excludeId: string): string | null {
    for (const [id, value] of Object.entries(this.current)) {
      if (id === excludeId) continue;
      if (value !== spec) continue;
      return DEFAULT_SHORTCUTS.find((def) => def.id === id)?.label ?? id;
    }
    return null;
  }

  /** 重建反查表。冲突时**保留默认顺序里靠前的那条**，并把冲突显示在面板顶上 */
  private rebuildReverse(): void {
    this.reverse = new Map();
    for (const def of DEFAULT_SHORTCUTS) {
      const spec = this.current[def.id];
      if (!spec) continue;
      if (!this.reverse.has(spec)) this.reverse.set(spec, def.id);
    }
  }

  private loadFromStorage(): void {
    const stored = readStoredBindings(this.storageKey);
    if (!stored) return;
    for (const [id, value] of Object.entries(stored)) {
      // 只认表里有的 id（旧版本删掉的 id 直接忽略），键位串必须能规范化
      if (!(id in this.defaults)) continue;
      const spec = normalizeKeySpec(value);
      if (!spec) continue;
      this.current[id] = spec;
    }
  }

  private persist(): void {
    writeStoredBindings(this.storageKey, this.current);
  }

  // ---------------------------------------------------------------- 开合

  open(): void {
    if (this.disposed || !this.overlay) return;
    this.overlay.style.display = 'block';
    // 打开时清掉上次的搜索词：玩家再打开是想看全表，不是接着上次筛
    this.searchQuery = '';
    if (this.searchEl) this.searchEl.value = '';
    this.render();
  }

  close(): void {
    if (!this.overlay) return;
    this.cancelCapture();
    this.overlay.style.display = 'none';
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ---------------------------------------------------------------- 按键捕获

  private beginCapture(id: string): void {
    this.capturingId = id;
    this.render();
  }

  private cancelCapture(): void {
    if (!this.capturingId) return;
    this.capturingId = null;
    this.render();
  }

  /**
   * 窗口级键盘事件。
   *
   * 两种状态：
   * - **捕获态**：玩家刚点了某条键位，下一个按下的键就是新绑定（修饰键单独按也认，见 keySpecFromEvent）；
   * - **常态**：只处理 `?`（Shift+/）与 F1 的开合。
   *
   * 接线注意：Engine 里现在也处理 F1 / Shift+/ 开合旧面板，
   * 换成这个面板时**必须把 Engine 那两处删掉**，否则一次按键开 + 关 = 看起来没反应。
   */
  private readonly handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed) return;

    if (this.capturingId) {
      // 捕获态下不 preventDefault 会有副作用：比如按 Tab 直接把焦点移走、按空格滚动页面
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        // 捕获态下 Esc 固定是"退出捕获"。代价是**没法用界面把某个动作改成 Esc** ——
        // 想绑回去只能点「恢复默认」（默认表里 Esc 就是"取消"）。这是明知的取舍：
        // 一个随时能按的逃生门，比"能把动作绑到 Esc"更重要。
        this.cancelCapture();
        return;
      }
      const spec = keySpecFromEvent({
        code: event.code,
        ctrlKey: event.ctrlKey || event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      });
      const id = this.capturingId;
      if (!spec) {
        this.setStatusBanner('这个键认不出来（可能是媒体键或输入法相关键），换一个试试', 'error');
        return;
      }
      const result = this.setBinding(id, spec);
      if (!result.ok) {
        this.setStatusBanner(result.reason ?? '改键失败', 'error');
        return;
      }
      this.capturingId = null;
      this.setStatusBanner(`已把「${DEFAULT_SHORTCUTS.find((def) => def.id === id)?.label ?? id}」改成 ${displayKeySpec(spec)}`, 'ok');
      this.render();
      return;
    }

    // 常态：输入框里打字时不抢开合（在搜索框里打 ? 是搜索，不是开面板）
    if (isTypingElement(document.activeElement)) return;
    const spec = keySpecFromEvent({
      code: event.code,
      ctrlKey: event.ctrlKey || event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
    if (spec === 'F1' || spec === 'Shift+/') {
      event.preventDefault();
      this.toggle();
    }
  };

  // ---------------------------------------------------------------- 渲染

  private render(): void {
    if (!this.container) return;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;

    if (!this.overlay) this.buildShell();
    this.renderBanner();
    this.renderList();
  }

  /** 搭骨架：只在第一次 render 时建节点，之后只更新内容（省得每次改键都重建整棵树） */
  private buildShell(): void {
    const container = this.container;
    if (!container) return;

    Object.assign(container.style, STYLE.overlay);
    const card = make('div', STYLE.card);

    const header = make('div', STYLE.header);
    const title = make('h2', STYLE.title, '⌨ 快捷键设置');
    title.style.margin = '0';
    const search = make('input', STYLE.input);
    search.type = 'search';
    search.placeholder = '搜索动作或按键…';
    search.setAttribute('aria-label', '搜索快捷键');
    const reset = make('button', STYLE.button, '恢复默认');
    reset.type = 'button';
    const close = make('button', STYLE.button, '关闭');
    close.type = 'button';
    header.append(title, search, reset, close);

    const banner = make('div', STYLE.banner);
    banner.style.display = 'none';
    const list = make('div', STYLE.group);

    card.append(header, banner, list);
    container.appendChild(card);

    this.overlay = container;
    this.listEl = list;
    this.bannerEl = banner;
    this.searchEl = search;

    this.bindBox(search, 'input', () => {
      this.searchQuery = search.value;
      this.renderList();
    });
    this.bindBox(reset, 'click', () => {
      this.resetAll();
      this.setStatusBanner('已恢复全部默认键位', 'ok');
    });
    this.bindBox(close, 'click', () => this.close());
    // 点遮罩空白处关闭（点卡片内部不关）
    this.bindBox(container, 'click', (event) => {
      if (event.target === container) this.close();
    });
  }

  /** 挂一个监听并记账（dispose 时统一摘）。回调收真实事件，遮罩点击关面板要判断 target */
  private bindBox(el: HTMLElement, type: string, listener: (event: Event) => void): void {
    const wrapped: EventListener = (event) => listener(event);
    el.addEventListener(type, wrapped);
    this.boxListeners.push({ el, type, listener: wrapped });
  }

  /**
   * 顶部横幅：优先显示**冲突**（红），其次是操作结果 / 报错（黄）。
   * 冲突永远压过其它消息 —— 它是"按键不响"的真正原因，被一句"已保存"盖住就没用了。
   */
  private setStatusBanner(text: string, tone: 'ok' | 'error'): void {
    this.statusText = text;
    this.statusTone = tone;
    this.renderBanner();
  }

  private renderBanner(): void {
    const banner = this.bannerEl;
    if (!banner) return;
    const conflicts = this.conflicts();
    const errors = conflicts.filter((item) => item.severity === 'error');
    const warns = conflicts.filter((item) => item.severity === 'warn');
    const lines: string[] = [];

    for (const item of errors) lines.push(`⚠ 冲突：${item.message}`);
    for (const item of warns) lines.push(`· 提示：${item.message}`);
    if (lines.length === 0 && this.statusText) lines.push(this.statusText);

    if (lines.length === 0) {
      banner.style.display = 'none';
      banner.textContent = '';
      return;
    }

    banner.style.display = 'block';
    const isError = errors.length > 0 || (warns.length === 0 && this.statusTone === 'error');
    banner.style.background = isError ? 'rgba(255, 107, 90, 0.14)' : 'rgba(127, 208, 106, 0.12)';
    banner.style.borderColor = isError ? 'var(--danger, #ff6b5a)' : 'var(--accent, #7fd06a)';
    banner.textContent = lines.join('\n');
    banner.style.whiteSpace = 'pre-wrap';
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    if (!list.ownerDocument || typeof list.ownerDocument.createElement !== 'function') return;

    const query = this.searchQuery.trim().toLowerCase();
    const conflictingIds = new Set<string>();
    for (const item of this.conflicts()) {
      for (const id of item.ids) conflictingIds.add(id);
    }

    const groups = new Map<string, ShortcutDef[]>();
    for (const def of DEFAULT_SHORTCUTS) {
      const keys = this.current[def.id] ?? def.defaultKeys;
      const hit =
        query === '' ||
        def.label.toLowerCase().includes(query) ||
        def.group.toLowerCase().includes(query) ||
        keys.toLowerCase().includes(query) ||
        displayKeySpec(keys).toLowerCase().includes(query);
      if (!hit) continue;
      const bucket = groups.get(def.group);
      if (bucket) bucket.push(def);
      else groups.set(def.group, [def]);
    }

    while (list.firstChild) list.removeChild(list.firstChild);
    this.listListeners = [];

    for (const groupName of SHORTCUT_GROUPS) {
      const defs = groups.get(groupName);
      if (!defs || defs.length === 0) continue;

      const groupRow = make('div', STYLE.group, `${groupName}（${defs.length}）`);
      list.appendChild(groupRow);

      for (const def of defs) {
        const spec = this.current[def.id] ?? def.defaultKeys;
        const row = make('div', STYLE.row);
        if (conflictingIds.has(def.id)) Object.assign(row.style, STYLE.rowConflict);

        const capturing = this.capturingId === def.id;
        const kbd = make('button', STYLE.kbd, capturing ? CAPTURE_HINT : displayKeySpec(spec));
        kbd.type = 'button';
        kbd.title = `点击后按下新键位（当前 ${spec}）`;
        kbd.setAttribute('aria-label', `${def.label} 的键位，当前 ${displayKeySpec(spec)}，点击改键`);
        if (capturing) kbd.style.color = 'var(--accent-2, #ffcc4d)';
        const onKbdClick = (): void => {
          this.setStatusBanner(`正在为「${def.label}」捕获按键…`, 'ok');
          this.beginCapture(def.id);
        };
        kbd.addEventListener('click', onKbdClick);
        this.listListeners.push({ el: kbd, type: 'click', listener: onKbdClick as EventListener });

        const label = make('span', STYLE.label, def.label);
        row.append(kbd, label);
        list.appendChild(row);
      }
    }

    if (list.childElementCount === 0) {
      list.appendChild(make('div', STYLE.group, `没有匹配「${this.searchQuery}」的快捷键`));
    }
  }

  /**
   * 收尾。
   *
   * 只摘**还挂在文档里**的那些监听：window 上的开合/捕获监听、骨架上的搜索与按钮监听。
   * 列表行上的监听不逐条摘 —— 那些节点每次重画都被换成新的，旧节点连着监听一起被回收。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('keydown', this.handleWindowKeyDown);
    }
    for (const entry of this.boxListeners) entry.el.removeEventListener(entry.type, entry.listener);
    this.boxListeners.length = 0;
    this.listListeners = [];
    this.overlay = null;
    this.listEl = null;
    this.bannerEl = null;
    this.searchEl = null;
    this.capturingId = null;
  }
}
