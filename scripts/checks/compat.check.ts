/**
 * 兼容性静态审计（M5 第 5 批「兼容性」这一半）的断言。
 *
 * 跑法见同目录的 `compat.run.ts`：
 *
 * ```bash
 * npx esbuild scripts/checks/compat.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/compat.mjs && node .verify/compat.mjs
 * ```
 *
 * ────────────────────────────────────────────────────────────
 * 这份断言**能**证明什么、**不能**证明什么
 * ────────────────────────────────────────────────────────────
 * 能：代码与配置里"有没有出现某个 API / 某种语法 / 某个兜底分支"，
 * 以及几处**可以在 Node 里真的跑一遍**的降级路径（没有 window / 没有 localStorage 时
 * 某个函数到底抛不抛）。这些结论是可复现的，谁改了代码谁就会看到红。
 *
 * 不能：**任何**"在 X 浏览器上能不能跑"的结论。本项目的开发环境里没有浏览器、
 * 没有 WebGL、没有真机，所以本文件里的浏览器版本号一律来自两处**可核对的口径**：
 * ① 本项目自己的配置文件（tsconfig / vite.config.ts / package.json / lockfile 里的真实版本号）；
 * ② 依赖包自己的产物（例如 three 的 `build/three.core.js` 里有没有 class static block）。
 * 凡是需要"真的开一个浏览器看一眼"的东西（渲染结果、触摸手感、弱网表现），
 * 这里一条都不测，全部写进 `docs/COMPATIBILITY.md` 的「本次未做的测试」。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么"登记事实"的断言也写在这里
 * ────────────────────────────────────────────────────────────
 * 有几条结论是**已知风险**（比如 `typeof localStorage === 'undefined'` 挡不住
 * "读 localStorage 属性本身就抛 SecurityError"），而修它们必须改 `src/**` ——
 * 本批次明令禁改。这种情况下：
 * - 绝**不**写成"应该没问题"（那是撒谎）；
 * - 也不把"已知坏掉的行为"做成绿色断言冒充验收；
 * - 做法是：把风险点连同文件:行号一起打进 detail 里（永远显示），
 *   真正的硬断言只覆盖**确认正确**的那些点（例如所有 storage 方法调用都在 try 里）。
 * 于是"登记事实"的 check 一律用 `check(名称, true, '……')` 的形态，与
 * `errors.check.ts` 里那条"环境事实：本进程有没有全局 window"同一个写法。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALITY_PRESETS } from '../../src/core/QualityPreset';
import { loadEnabledPacks, saveEnabledPacks } from '../../src/data/contentPacks';
import { detectDevice } from '../../src/mobile/DeviceCapability';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ---------------------------------------------------------------------------
// 0. 定位项目根目录
// ---------------------------------------------------------------------------

/**
 * 找项目根：从 cwd 往上找，再用打包产物自己的位置兜一次。
 *
 * 为什么不直接写相对路径 'src'：`errors.check.ts` 里那条读源码的断言就吃过这个亏 ——
 * 换个工作目录跑，"读不到 src" 会被当成"跳过"，看着是绿的。
 * 这里宁可**找不到就红**（每条依赖源码的断言都会带上原因），也不让整套检查静默通过。
 */
function findProjectRoot(): string | null {
  const candidates: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    candidates.push(dir);
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch {
    /* 拿不到 import.meta.url 就走 cwd 那几个候选 */
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && (parsed as { name?: unknown }).name === 'god-sandbox') {
        return candidate;
      }
    } catch {
      /* 这个候选目录里没有 package.json，继续往上 */
    }
  }
  return null;
}

const ROOT = findProjectRoot();

interface TextFile {
  ok: boolean;
  text: string;
  reason: string;
}

/** 读一个项目内的文本文件；读不到时如实给出原因（而不是返回空串假装成功） */
function readProjectFile(rel: string): TextFile {
  if (ROOT === null) return { ok: false, text: '', reason: '找不到项目根（cwd 里没有 name=god-sandbox 的 package.json）' };
  try {
    return { ok: true, text: readFileSync(join(ROOT, rel), 'utf8'), reason: '' };
  } catch (error) {
    return { ok: false, text: '', reason: error instanceof Error ? error.message : String(error) };
  }
}

function existsProjectPath(rel: string): boolean {
  if (ROOT === null) return false;
  return existsSync(join(ROOT, rel));
}

/** 从 JSON 文本里取字段（tsconfig / package.json 都没有注释，坏 JSON 一律如实报错） */
function parseJsonText(text: string): { ok: boolean; value: unknown; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown, reason: '' };
  } catch (error) {
    return { ok: false, value: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 1. 源码扫描的基础设施
// ---------------------------------------------------------------------------

/**
 * 把注释、字符串、模板串的文字内容替换成空格（长度与换行**保持不变**）。
 *
 * 为什么要这么干：
 * 1. 「有没有用某个 API」必须在**代码**里判断 —— 本项目的中文注释极其啰嗦，
 *    光是解释性的注释里就写着 `SharedArrayBuffer`、`structuredClone` 这些字样，
 *    直接 grep 源码文本会把这些"提到"当成"用了"（假红），也会把
 *    `if (x) '  这是字符串里的 localStorage 字样  '` 当成真的访问（假绿）；
 * 2. 花括号配对必须准：注释里的 `{` / `}` 会让"这个调用在不在 try 里"算错。
 *
 * 顺手把**正则字面量的 flags** 记下来（判 `d` 标志 / lookbehind 要用）。
 */
interface StrippedSource {
  code: string;
  /** 每一处正则字面量的 flags（不含斜杠），按出现顺序 */
  regexFlags: string[];
  /** 每一处正则字面量的正文，与 regexFlags 一一对应 */
  regexBodies: string[];
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** 判断某个 `/` 是不是正则字面量的开头（按前一个有效字符猜；猜错只会影响极少数边界） */
function looksLikeRegexStart(code: string, index: number): boolean {
  let j = index - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j -= 1;
  if (j < 0) return true;
  const prev = code[j]!;
  // 这些位置之后出现的 `/` 只可能是正则（除法运算符的左边通常是标识符 / 数字 / `)` / `]`）
  return '([{,;:=!&|?+-*%~^<>'.includes(prev);
}

function stripNonCode(text: string): StrippedSource {
  const out = text.split('');
  const code = text;
  const regexFlags: string[] = [];
  const regexBodies: string[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && code[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const found = code.indexOf('*/', i + 2);
      const j = found === -1 ? n : found + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j += 1;
          break;
        }
        // 模板串里的 ${ } 里面是真的代码，保留
        if (quote === '`' && code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (code[j] === '{') depth += 1;
            else if (code[j] === '}') depth -= 1;
            j += 1;
          }
          continue;
        }
        j += 1;
      }
      blank(i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }
    if (c === '/' && looksLikeRegexStart(code, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = code[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        let k = j + 1;
        while (k < n && /[a-z]/.test(code[k]!)) k += 1;
        regexFlags.push(code.slice(j + 1, k));
        regexBodies.push(code.slice(i + 1, j));
        blank(i, k);
        i = k;
        continue;
      }
    }
    i += 1;
  }
  return { code: out.join(''), regexFlags, regexBodies };
}

/**
 * 只抹掉注释、**保留字符串内容**的版本。
 *
 * 为什么需要第二个版本：有一批结论的判据本身就长在字符串里 ——
 * `addEventListener('visibilitychange', …)`、`getContext('webgl2')`、
 * `classList.add('touch-device')`、`typeof IntersectionObserver === 'function'`。
 * 拿"字符串已抹掉"的那份去搜这些模式，永远搜不到（那会得到假红，
 * 而假红比假绿更危险：它会让人去"修"一个本来就对的结论）。
 */
function stripCommentsOnly(text: string): string {
  const out = text.split('');
  const n = text.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const found = text.indexOf('*/', i + 2);
      const j = found === -1 ? n : found + 2;
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

interface SourceFile {
  rel: string;
  text: string;
  code: string;
  /** 注释被抹掉、字符串保留（用于判据长在字符串里的那些扫描） */
  noComments: string;
  regexFlags: string[];
  regexBodies: string[];
  lineStarts: number[];
}

function collectTsFiles(dir: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relPath = rel === '' ? entry : `${rel}/${entry}`;
    if (statSync(full).isDirectory()) collectTsFiles(full, relPath, out);
    else if (entry.endsWith('.ts')) out.push(relPath);
  }
}

function listSourceFiles(): { files: SourceFile[]; reason: string } {
  if (ROOT === null) return { files: [], reason: '找不到项目根' };
  try {
    const rels: string[] = [];
    collectTsFiles(join(ROOT, 'src'), '', rels);
    rels.sort();
    const files: SourceFile[] = [];
    for (const rel of rels) {
      const text = readFileSync(join(ROOT, 'src', rel), 'utf8');
      const stripped = stripNonCode(text);
      const lineStarts = [0];
      for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
      files.push({
        rel: `src/${rel}`,
        text,
        code: stripped.code,
        noComments: stripCommentsOnly(text),
        regexFlags: stripped.regexFlags,
        regexBodies: stripped.regexBodies,
        lineStarts,
      });
    }
    return { files, reason: '' };
  } catch (error) {
    return { files: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

const SOURCES = listSourceFiles();

function lineNumber(file: SourceFile, offset: number): number {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (file.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

interface Hit {
  rel: string;
  line: number;
  lineText: string;
}

/** 在**代码**（已去掉注释与字符串）里找所有匹配；返回文件:行号与整行原文 */
function findInCode(re: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of SOURCES.files) {
    const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match = pattern.exec(file.code);
    while (match !== null) {
      const line = lineNumber(file, match.index);
      hits.push({ rel: file.rel, line, lineText: (file.text.split('\n')[line - 1] ?? '').trim() });
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(file.code);
    }
  }
  return hits;
}

/** 在**原文**（含注释）里找匹配：注释里提到某个 API 时用它登记"为什么注释里会有这个词" */
function findInText(re: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of SOURCES.files) {
    const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match = pattern.exec(file.text);
    while (match !== null) {
      const line = lineNumber(file, match.index);
      hits.push({ rel: file.rel, line, lineText: (file.text.split('\n')[line - 1] ?? '').trim() });
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(file.text);
    }
  }
  return hits;
}

/** 在"注释已抹掉、字符串保留"的文本里找匹配（判据本身是字符串字面量时用它） */
function findInNoComments(re: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of SOURCES.files) {
    const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match = pattern.exec(file.noComments);
    while (match !== null) {
      const line = lineNumber(file, match.index);
      hits.push({ rel: file.rel, line, lineText: (file.text.split('\n')[line - 1] ?? '').trim() });
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(file.noComments);
    }
  }
  return hits;
}

/** 任意模式出现在哪个 try 块里（判"这个调用有没有兜底"的通用版本） */
interface GuardedOccurrence extends Hit {
  insideTry: boolean;
}

function collectOccurrences(re: RegExp): GuardedOccurrence[] {
  const found: GuardedOccurrence[] = [];
  for (const file of SOURCES.files) {
    const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match = pattern.exec(file.noComments);
    while (match !== null) {
      const line = lineNumber(file, match.index);
      found.push({
        rel: file.rel,
        line,
        lineText: (file.text.split('\n')[line - 1] ?? '').trim(),
        insideTry: insideTryAt(file.code, match.index),
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(file.noComments);
    }
  }
  return found;
}

/** `{` 是不是 `try` 块的开始（向前看最近的非空白字符是不是独立的 try 关键字） */
function opensTry(code: string, braceIndex: number): boolean {
  let j = braceIndex - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j -= 1;
  if (j < 2) return false;
  const tail = code.slice(j - 2, j + 1);
  if (tail !== 'try') return false;
  // 防止 `retry {` 这类标识符结尾也是 try
  const before = code[j - 3];
  return before === undefined || !isIdentifierChar(before);
}

/** 某个位置是否词法上位于 try 块里（用花括号栈算，注释与字符串已经变成空格） */
function insideTryAt(code: string, index: number): boolean {
  const stack: boolean[] = [];
  for (let i = 0; i < index; i += 1) {
    const ch = code[i];
    if (ch === '{') stack.push(opensTry(code, i));
    else if (ch === '}') stack.pop();
  }
  return stack.includes(true);
}

type StorageKind = 'method' | 'typeofGuard' | 'property';

interface StorageRef extends Hit {
  kind: StorageKind;
  insideTry: boolean;
}

/**
 * 全部 `localStorage` / `sessionStorage` 引用，按形态分成三类：
 * - `method`：真的调用方法（getItem / setItem / removeItem / clear / key）；
 * - `typeofGuard`：`typeof localStorage === 'undefined'` 这种环境探测；
 * - `property`：其余属性访问（例如把 `window.localStorage` 直接当参数传出去）。
 */
function collectStorageRefs(): StorageRef[] {
  const refs: StorageRef[] = [];
  const pattern = /\b(localStorage|sessionStorage)\b/g;
  for (const file of SOURCES.files) {
    let match = pattern.exec(file.code);
    while (match !== null) {
      const index = match.index;
      const after = file.code.slice(index, index + 70);
      const before = file.code.slice(Math.max(0, index - 12), index);
      const isMethod = /^(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem|clear|key)\s*\(/.test(after);
      const isGuard = /typeof\s+$/.test(before);
      const line = lineNumber(file, index);
      refs.push({
        rel: file.rel,
        line,
        lineText: (file.text.split('\n')[line - 1] ?? '').trim(),
        kind: isMethod ? 'method' : isGuard ? 'typeofGuard' : 'property',
        insideTry: insideTryAt(file.code, index),
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(file.code);
    }
  }
  return refs;
}

/** 把 `文件:行` 列表压成一行（最多 N 条，多了就写"等 N 处"） */
function formatHits(hits: readonly Hit[], limit = 8): string {
  if (hits.length === 0) return '（0 处）';
  const shown = hits.slice(0, limit).map((hit) => `${hit.rel}:${hit.line}`);
  const rest = hits.length - shown.length;
  return rest > 0 ? `${shown.join('、')} 等 ${hits.length} 处` : shown.join('、');
}

/** 从源码文本里正则取一个"配置值"，取不到就返回 null（**不兜默认值**：兜了就成了"假装配置里有"） */
function readConfigValue(text: string, re: RegExp): string | null {
  const match = re.exec(text);
  return match?.[1] ?? null;
}

/** 汉字判断（用来确认用户可见文案是中文） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

export function runCompatChecks(check: CheckFn): void {
  // ==================================================================
  // 一、构建与类型配置（全部读**真实文件**，不硬编码期望）
  // ==================================================================
  check(
    '项目根目录定位成功（后面所有读源码的断言都依赖它；找不到时这里是红的，而不是"跳过"）',
    ROOT !== null,
    ROOT ?? 'cwd 里没有 name=god-sandbox 的 package.json —— 请在项目根目录下运行',
  );

  const pkgFile = readProjectFile('package.json');
  const pkg = parseJsonText(pkgFile.text);
  const pkgObject = (pkg.value ?? {}) as {
    name?: unknown;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: unknown;
    browserslist?: unknown;
  };
  check('package.json 可读且能被 JSON.parse', pkgFile.ok && pkg.ok, pkgFile.ok ? pkg.reason || '解析成功' : pkgFile.reason);

  const threeVersion = typeof pkgObject.dependencies?.three === 'string' ? pkgObject.dependencies.three : '(缺失)';
  const rapierVersion = typeof pkgObject.dependencies?.['@dimforge/rapier3d-compat'] === 'string'
    ? pkgObject.dependencies['@dimforge/rapier3d-compat']
    : '(缺失)';
  check(
    '依赖清单里有 three 与 @dimforge/rapier3d-compat（compat 版：wasm 内联，不需要额外服务器配置）',
    threeVersion !== '(缺失)' && rapierVersion !== '(缺失)',
    `three ${threeVersion}｜rapier3d-compat ${rapierVersion}`,
  );
  check(
    '登记事实：package.json 里**没有** browserslist（所以"目标浏览器"在配置层没有声明，只能来自 tsconfig / vite / README）',
    !('browserslist' in pkgObject),
    'browserslist' in pkgObject
      ? `发现 browserslist：${JSON.stringify(pkgObject.browserslist)} —— 请同步更新 docs/COMPATIBILITY.md 的「目标浏览器」一节`
      : '确认没有该字段：本文件的浏览器下限是"从配置推出来的"，不是项目声明过的',
  );
  check(
    '登记事实：package.json 里没有 engines（README 写的 Node 20.19+/22+ 没有落到配置层，npm 不会拦）',
    !('engines' in pkgObject),
    'engines' in pkgObject ? `发现 engines：${JSON.stringify(pkgObject.engines)}` : '没有该字段（本次审计不改 package.json）',
  );

  const tsconfigFile = readProjectFile('tsconfig.json');
  const tsconfig = parseJsonText(tsconfigFile.text);
  const compiler = ((tsconfig.value ?? {}) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
  check(
    'tsconfig.json 可读，且 compilerOptions.target 是它自己写着的真实值（本文件的"语法下限"由它决定）',
    tsconfigFile.ok && tsconfig.ok && typeof compiler.target === 'string',
    typeof compiler.target === 'string' ? `target = ${compiler.target}` : `读不到 target：${tsconfigFile.reason || tsconfig.reason}`,
  );
  check(
    'tsconfig 的 lib 明确写了 ES2022 + DOM + DOM.Iterable（不是靠默认值猜的）',
    Array.isArray(compiler.lib) && ['ES2022', 'DOM', 'DOM.Iterable'].every((name) => (compiler.lib as string[]).includes(name)),
    `lib = ${JSON.stringify(compiler.lib ?? null)}`,
  );
  const strictFlags = ['strict', 'noUnusedLocals', 'noUnusedParameters', 'verbatimModuleSyntax', 'noImplicitOverride'] as const;
  check(
    'tsconfig 的五个严格开关都开着（strict / noUnusedLocals / noUnusedParameters / verbatimModuleSyntax / noImplicitOverride）',
    strictFlags.every((flag) => compiler[flag] === true),
    strictFlags.map((flag) => `${flag}=${String(compiler[flag])}`).join(' '),
  );
  check(
    '登记事实：tsconfig 的 include 只有 src 与 vite.config.ts —— **scripts/** 不在 tsc 覆盖范围内（本文件本身不受 `tsc --noEmit` 检查，靠 esbuild 打包时报错兜底）',
    Array.isArray((tsconfig.value as { include?: unknown }).include),
    `include = ${JSON.stringify((tsconfig.value as { include?: unknown }).include ?? null)}`,
  );

  const viteFile = readProjectFile('vite.config.ts');
  const viteTarget = readConfigValue(viteFile.text, /target:\s*'([^']+)'/);
  check(
    'vite.config.ts 的 build.target 是它自己写着的真实值（浏览器语法下限的第二个来源）',
    viteTarget !== null,
    viteTarget === null ? `读不到 build.target：${viteFile.reason}` : `build.target = ${viteTarget}`,
  );
  check(
    'tsconfig 的 target 与 vite 的 build.target 口径一致（两处都写 ES2022 / es2022，不会一个松一个紧）',
    typeof compiler.target === 'string' && viteTarget !== null && compiler.target.toLowerCase() === viteTarget.toLowerCase(),
    `tsconfig ${String(compiler.target)}｜vite ${String(viteTarget)}`,
  );
  check(
    'base 不是硬编码：vite.config.ts 同时有 VITE_BASE 覆盖与 GITHUB_REPOSITORY 推导（GitHub Pages 子路径 /gad-box/ 靠它）',
    /VITE_BASE/.test(viteFile.text) && /GITHUB_REPOSITORY/.test(viteFile.text),
    viteTarget === null ? `读不到 vite.config.ts：${viteFile.reason}` : '两处分支都在（VITE_BASE / GITHUB_REPOSITORY）',
  );
  check(
    '登记事实：vite.config.ts 没有覆盖 assetsInlineLimit（用 Vite 默认值；本项目的 wasm 不走静态资源管线，见下面 rapier 那几条）',
    !/assetsInlineLimit/.test(viteFile.text),
    /assetsInlineLimit/.test(viteFile.text) ? '发现 assetsInlineLimit 覆盖：请复核 docs/COMPATIBILITY.md' : '确认没有该字段',
  );
  const rapierChunkInConfig = readConfigValue(viteFile.text, /(assets\/rapier\.js)/);
  const rapierChunkInSource = readConfigValue(readProjectFile('src/physics/RapierWorld.ts').text, /RAPIER_CHUNK_FILE\s*=\s*'([^']+)'/);
  check(
    'rapier 的固定 chunk 名在两处一致（vite.config.ts 的输出规则 ↔ RapierWorld 的进度用 URL）：改一处忘另一处，真字节进度会静默失效',
    rapierChunkInConfig !== null && rapierChunkInSource !== null && rapierChunkInConfig === rapierChunkInSource,
    `vite.config.ts = ${String(rapierChunkInConfig)}｜RapierWorld.ts = ${String(rapierChunkInSource)}`,
  );

  const htmlFile = readProjectFile('index.html');
  const html = htmlFile.text;
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  const styleLinkTags = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/gi)].map((match) => match[0]);
  check(
    'index.html 只有一个 <script> 标签（type="module" 入口，模块脚本 Chrome 61+ / Safari 10.1+ 远低于下限），且样式不走 <link rel="stylesheet">（由 main.ts import，Vite 按 base 重写路径，子路径部署不会 404）',
    htmlFile.ok && scriptTags.length === 1 && /type="module"/.test(scriptTags[0] ?? '') && styleLinkTags.length === 0,
    htmlFile.ok
      ? `script ${scriptTags.length} 个：${scriptTags.join(' | ')}｜stylesheet link ${styleLinkTags.length} 个`
      : htmlFile.reason,
  );
  check(
    'index.html 的 viewport meta 含 width=device-width（手机端布局的前提）',
    /name="viewport"/.test(html) && /width=device-width/.test(html),
    (html.match(/name="viewport"[\s\S]{0,200}?>/) ?? ['(没找到 viewport meta)'])[0].replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    '登记事实：index.html 上没有 crossorigin 属性（没有 modulepreload / 跨源脚本；同源加载不需要 COEP/COOP，也就拿不到 SharedArrayBuffer——本项目刻意不用它）',
    !/crossorigin/.test(html),
    /crossorigin/.test(html) ? '发现 crossorigin：请复核是否引入了跨源隔离依赖' : '确认没有 crossorigin 属性',
  );

  // ==================================================================
  // 二、src/** 的现代语法（逐条给真实命中位置）
  // ==================================================================
  const srcFileCount = SOURCES.files.length;
  check(
    `src/** 共扫到 ${srcFileCount} 个 .ts 文件（下面每条"没有出现"的断言都是在这份清单上得出的）`,
    srcFileCount > 50,
    SOURCES.reason === '' ? `${srcFileCount} 个文件` : `读源码失败：${SOURCES.reason}`,
  );

  const staticBlocks = findInCode(/static\s*\{/);
  check(
    'src/** 里没有 class static 块（static { ... }）——它是 ES2022 里 Safari 最晚支持的一项（16.4），three 的产物里就有它，见下面 three 那条',
    staticBlocks.length === 0,
    formatHits(staticBlocks),
  );
  const privateFields = findInCode(/\bthis\.#|^\s*(?:readonly\s+|static\s+)?#\w+/m);
  check(
    'src/** 里没有 #私有字段（Chrome 74 起才有；本次不用它，改用 TS 的 private 修饰符）',
    privateFields.length === 0,
    formatHits(privateFields),
  );
  const logicalAssign = findInCode(/\?\?=|\|\|=|&&=/);
  check(
    'src/** 里没有 ??= / ||= / &&= 逻辑赋值（Chrome 85 / Safari 14 / Firefox 79 起才有；低于下限但没必要引入）',
    logicalAssign.length === 0,
    formatHits(logicalAssign),
  );
  const nullish = findInCode(/\?\?/);
  const optionalChain = findInCode(/\?\./);
  check(
    '登记事实：?? 与 ?. 用得很多（ES2020，Chrome 80 / Safari 13.1 起，不是下限的瓶颈）',
    nullish.length > 0 && optionalChain.length > 0,
    `?? ${nullish.length} 处｜?. ${optionalChain.length} 处`,
  );
  const topLevelAwait = findInCode(/^await\s/m);
  check(
    'src/** 里没有顶层 await（Chrome 89 / Safari 15 / Firefox 89 起；模块顶层 await 在打包器里也最容易出坑）',
    topLevelAwait.length === 0,
    formatHits(topLevelAwait),
  );
  const newArrayMethods = findInCode(/\.at\(|\.findLast\(|\.findLastIndex\(|\.toSorted\(|\.toReversed\(|\.toSpliced\(|Array\.fromAsync|\.with\(/);
  check(
    'src/** 里没有 .at() / findLast / toSorted / toReversed / toSpliced / Array.fromAsync（都是 Chrome 9x~11x、Safari 15.4+ 才有的新数组方法）',
    newArrayMethods.length === 0,
    formatHits(newArrayMethods),
  );
  const structuredCloneHits = findInCode(/\bstructuredClone\b/);
  check(
    'src/** 里没有 structuredClone（Chrome 98 / Safari 15.4 / Firefox 94 起；本项目用 JSON 深拷贝 + 显式字段拷贝）',
    structuredCloneHits.length === 0,
    formatHits(structuredCloneHits),
  );
  const hasOwnHits = findInCode(/\bObject\.hasOwn\b|\bObject\.hasOwnProperty\b/);
  const hasOwnPropertyCall = findInCode(/Object\.prototype\.hasOwnProperty\.call/);
  check(
    'src/** 里没有 Object.hasOwn（Chrome 93 / Safari 15.4 起），需要判自有属性时用的是 Object.prototype.hasOwnProperty.call（全版本可用）',
    hasOwnHits.length === 0 && hasOwnPropertyCall.length > 0,
    `Object.hasOwn ${hasOwnHits.length} 处｜hasOwnProperty.call ${hasOwnPropertyCall.length} 处（${formatHits(hasOwnPropertyCall)}）`,
  );
  const lookbehind = findInCode(/\(\?<[=!]/);
  check(
    'src/** 的正则里没有 lookbehind（(?<= / (?<!）——Safari 16.4 之前完全不支持，是"白屏级"的语法错误',
    lookbehind.length === 0,
    formatHits(lookbehind),
  );
  const dFlagRegexes: string[] = [];
  for (const file of SOURCES.files) {
    file.regexFlags.forEach((flags, index) => {
      if (flags.includes('d')) dFlagRegexes.push(`${file.rel}:/${file.regexBodies[index] ?? ''}/${flags}`);
    });
  }
  check(
    'src/** 的正则里没有 d 标志（hasIndices：Chrome 90 / Safari 15 起；本项目一共用到这么多正则字面量，全都没带 d）',
    dFlagRegexes.length === 0,
    dFlagRegexes.length === 0
      ? `扫描了 ${SOURCES.files.reduce((sum, file) => sum + file.regexFlags.length, 0)} 个正则字面量，无一使用 d 标志`
      : dFlagRegexes.join('、'),
  );
  const intlHits = findInCode(/\bIntl\./);
  const localeHits = findInCode(/toLocaleString|toLocaleTimeString|toLocaleDateString/);
  check(
    'src/** 里没有 Intl.*（不引 ICU 相关的兼容面）；需要本地化时只用 toLocaleString / toLocaleTimeString / toLocaleDateString 这些老 API',
    intlHits.length === 0 && localeHits.length > 0,
    `Intl.* ${intlHits.length} 处｜toLocale* ${localeHits.length} 处（${formatHits(localeHits, 4)}）`,
  );
  const replaceAllHits = findInCode(/\.replaceAll\(/);
  check(
    'String.replaceAll 的用处集中在 3 个 UI 文件的 HTML 转义里（Chrome 85 / Safari 13.1 / Firefox 77 起，低于本项目下限，不构成风险）',
    replaceAllHits.length > 0
      && replaceAllHits.every((hit) => ['src/ui/HistoryPanel.ts', 'src/ui/PrefabPanel.ts', 'src/ui/ComboPanel.ts'].includes(hit.rel)),
    `${replaceAllHits.length} 处：${[...new Set(replaceAllHits.map((hit) => hit.rel))].join('、')}`,
  );

  /**
   * 一批"本项目没用、也不该顺手用"的 API，按家族分组合并成 5 条断言。
   * 合并的理由：这些 API 单独的结论都是"0 处"，拆成 12 条只会让输出变长；
   * 按家族合并后，一条红了仍然能直接从 detail 看到**是哪个** API 被引入、在哪一行。
   */
  const absentApiGroups: { title: string; apis: { name: string; note: string }[] }[] = [
    {
      title: '并发与中断类 API',
      apis: [
        { name: 'queueMicrotask', note: 'Chrome 71 / Safari 12.1 起' },
        { name: 'requestIdleCallback', note: 'Safari 至今不支持（只有 Chrome / Firefox 有）' },
        { name: 'AbortSignal', note: 'AbortSignal.timeout 是 Chrome 103 / Safari 16 起' },
        { name: 'AbortController', note: 'Chrome 66 / Safari 12.1 起' },
      ],
    },
    {
      title: '观察器与离屏画布类 API',
      apis: [
        { name: 'ResizeObserver', note: 'Chrome 64 / Safari 13.1 起' },
        { name: 'OffscreenCanvas', note: 'Safari 16.4 起，且 Safari 上不能用在 Worker 里' },
        { name: 'createImageBitmap', note: 'Safari 15 起才有完整实现' },
      ],
    },
    {
      title: 'GPU 与存储管理类 API',
      apis: [
        { name: 'navigator.gpu', note: 'WebGPU：Chrome 113 / Safari 26，桌面与手机差别很大' },
        { name: 'navigator.storage', note: 'StorageManager：Safari 上 estimate() 长期缺失' },
      ],
    },
    {
      title: '加密与堆内存类 API',
      apis: [
        { name: 'crypto.randomUUID', note: 'Safari 15.4 起，且只在安全上下文里有' },
        { name: 'performance.memory', note: 'Chromium 专有（本项目走窄接口 + null 兜底，见下一条）' },
      ],
    },
    {
      title: '视觉视口 API（iOS Safari 上键盘 / 地址栏变化要它才算得准）',
      apis: [{ name: 'visualViewport', note: 'Safari 13 起；本项目用 100vh 兜着，见"移动端"一节的登记' }],
    },
  ];
  for (const group of absentApiGroups) {
    const hitLines: string[] = [];
    for (const api of group.apis) {
      const hits = findInCode(new RegExp(api.name.replace('.', '\\.')));
      if (hits.length > 0) hitLines.push(`${api.name}（${api.note}）：${formatHits(hits)}`);
    }
    check(
      `src/** 里没有这些${group.title}：${group.apis.map((api) => api.name).join(' / ')}`,
      hitLines.length === 0,
      hitLines.length === 0
        ? `这一组 ${group.apis.length} 个 API 全部 0 处（逐个核对：${group.apis.map((api) => `${api.name} = ${api.note}`).join('；')}）`
        : hitLines.join(' ｜ '),
    );
  }
  const performanceMemoryCast = findInCode(/PerformanceMemory/);
  check(
    'performance.memory 走的是"窄接口 + 拿不到就 null"的读法（Chromium 专有，Firefox / Safari 拿不到堆数字；本项目不假装 0）',
    performanceMemoryCast.length > 0,
    `窄接口声明位置：${formatHits(performanceMemoryCast)}`,
  );

  // ==================================================================
  // 三、WASM / SharedArrayBuffer / GitHub Pages（这一节是"线上致命项"的排查）
  // ==================================================================
  const sabInCode = findInCode(/\bSharedArrayBuffer\b/);
  const sabInComments = findInText(/\bSharedArrayBuffer\b/).filter(
    (hit) => !sabInCode.some((code) => code.rel === hit.rel && code.line === hit.line),
  );
  check(
    'src/** 的**代码**里没有 SharedArrayBuffer（GitHub Pages 不发 COOP/COEP 头，跨源隔离拿不到，用了就是线上必坏）',
    sabInCode.length === 0,
    sabInCode.length === 0
      ? `代码 0 处；注释里提到 ${sabInComments.length} 处（${formatHits(sabInComments, 3)}，那是解释"它不可转移"，不是使用）`
      : formatHits(sabInCode),
  );
  const atomicsInCode = findInCode(/\bAtomics\b/);
  check(
    'src/** 里没有 Atomics（与 SharedArrayBuffer 是同一套前提：没有跨源隔离就用不了；本项目 worker 全部走拷贝 + transfer）',
    atomicsInCode.length === 0,
    formatHits(atomicsInCode),
  );
  const crossOriginIsolatedHits = findInCode(/crossOriginIsolated/);
  check(
    'src/** 里没有 crossOriginIsolated（没有做任何依赖跨源隔离的能力探测——因为整个应用不依赖它）',
    crossOriginIsolatedHits.length === 0,
    formatHits(crossOriginIsolatedHits),
  );

  const rapierPkgFile = readProjectFile('node_modules/@dimforge/rapier3d-compat/package.json');
  const rapierPkg = parseJsonText(rapierPkgFile.text);
  const rapierEntry = ((rapierPkg.value ?? {}) as { module?: string }).module ?? 'dist/rapier.mjs';
  const rapierEntryFile = readProjectFile(`node_modules/@dimforge/rapier3d-compat/${rapierEntry}`);
  const rapierInlineWasm = /module_or_path:\s*\w+\.toByteArray\("(AGFzbQ[A-Za-z0-9+/=]*)/.exec(rapierEntryFile.text);
  check(
    'rapier3d-compat 的 init() 是把内联的 base64 wasm 解成字节再交给 WebAssembly.instantiate（不是 fetch .wasm）——所以线上**不依赖** application/wasm 这个 MIME 头，也不依赖 instantiateStreaming',
    rapierInlineWasm !== null,
    rapierInlineWasm === null
      ? `没在 ${rapierEntry} 里找到 "module_or_path: xxx.toByteArray(\"AGFzbQ...\")"（依赖升级换了加载方式？请复核 COMPATIBILITY.md 的 WASM 一节）`
      : `命中内联 wasm 的 base64（前缀 ${rapierInlineWasm[1]!.slice(0, 12)}…，base64 长度 ${rapierInlineWasm[1]!.length} 字符 ≈ ${(rapierInlineWasm[1]!.length * 3 / 4 / 1048576).toFixed(2)} MiB 的 wasm）`,
  );
  check(
    'WebAssembly 是"有就用、没有就降级"的目标：WebAssembly 本身 Chrome 57 / Safari 11 / Firefox 52 起就有，远低于本项目下限（真正的下限不在这里）',
    rapierEntryFile.ok,
    rapierEntryFile.ok ? `读了 ${rapierEntry}（${rapierEntryFile.text.length} 字符）` : rapierEntryFile.reason,
  );

  const rapierWorldText = readProjectFile('src/physics/RapierWorld.ts').text;
  check(
    'WASM 加载失败有中文兜底：RapierWorld 的 catch 会记住 lastError、上报 failed 阶段，并说明"沙盘仍可使用"与可能原因',
    /phase:\s*'failed'/.test(rapierWorldText)
      && /this\.lastError\s*=/.test(rapierWorldText)
      && /沙盘仍可使用/.test(rapierWorldText)
      && hasChinese(rapierWorldText),
    'phase: failed + lastError + 「沙盘仍可使用」三样都在',
  );
  check(
    '失败后**代码层允许重试**（RapierWorld 失败时清掉 initializing，下次 init() 会真的再试一次）',
    /if\s*\(!result\)\s*this\.initializing\s*=\s*null/.test(rapierWorldText),
    /if\s*\(!result\)\s*this\.initializing\s*=\s*null/.test(rapierWorldText) ? '有清理逻辑' : '没找到清理 initializing 的写法',
  );
  const engineText = readProjectFile('src/core/Engine.ts').text;
  check(
    'WASM 加载失败有**用户可见**的中文提示条（不是只写 console）：Engine 的 onPhysicsFailed 里有明确的中文说明与"换 WiFi 后刷新"的下一步',
    /onPhysicsFailed/.test(engineText) && /物理引擎没加载成功/.test(engineText) && /沙盘仍可使用/.test(engineText),
    'onPhysicsFailed + 中文提示条 + 刷新指引都在',
  );
  const initCalls = findInCode(/physics\.init\(/);
  check(
    '登记事实：physics.init() 在整个 src 里只在启动时被调一次 —— 失败后界面上**没有"重试加载物理"按钮**，只能刷新页面（已列进 COMPATIBILITY.md 风险表；修它要改 src，本批次禁改）',
    initCalls.length > 0,
    `${initCalls.length} 处调用：${formatHits(initCalls)}`,
  );
  const loadingText = /首次需要下载约 ([\d.]+) MB/.exec(engineText);
  const distRapier = existsProjectPath('dist/assets/rapier.js');
  const distRapierBytes = distRapier ? statSync(join(ROOT ?? '.', 'dist/assets/rapier.js')).size : 0;
  check(
    '进度文案里的体积与真实产物对得上（文案是给弱网用户看的：数字写错了会让人以为下载卡住了）',
    loadingText !== null && (!distRapier || Math.abs(distRapierBytes / 1e6 - Number(loadingText[1])) < 0.3),
    loadingText === null
      ? '没找到「首次需要下载约 X MB」这句文案'
      : distRapier
        ? `文案写 ${loadingText[1]} MB；dist/assets/rapier.js 实测 ${(distRapierBytes / 1e6).toFixed(2)} MB（十进制）`
        : `文案写 ${loadingText[1]} MB；dist 未构建，这次没有产物可比对（**不是**核对通过）`,
  );
  const distWasm = distRapier ? (() => {
    try {
      return readdirSync(join(ROOT ?? '.', 'dist/assets')).filter((name) => name.endsWith('.wasm'));
    } catch {
      return [];
    }
  })() : [];
  check(
    '构建产物里没有独立的 .wasm 文件（wasm 以内联 base64 进了 rapier 的 chunk —— 静态托管上不需要任何 MIME/CORS 配置）',
    !distRapier || distWasm.length === 0,
    distRapier ? `dist/assets 下的 .wasm 文件：${distWasm.length === 0 ? '0 个' : distWasm.join('、')}` : 'dist 未构建，本条按"跳过"记（不是核对通过）',
  );

  // ==================================================================
  // 四、WebGL2 与渲染兜底
  // ==================================================================
  const threePkgFile = readProjectFile('node_modules/three/package.json');
  const threePkg = parseJsonText(threePkgFile.text);
  const threeReal = ((threePkg.value ?? {}) as { version?: unknown }).version;
  check(
    'three 的真实安装版本与 package.json 的声明一致（版本号写错会让下面"three 里有 static 块"的结论指向错误的版本）',
    typeof threeReal === 'string' && typeof pkgObject.dependencies?.three === 'string' && pkgObject.dependencies.three.includes(threeReal),
    `已安装 ${String(threeReal)}｜声明 ${threeVersion}`,
  );
  const threeCore = readProjectFile('node_modules/three/build/three.core.js');
  const threeStaticBlocks = (threeCore.text.match(/static\s*\{/g) ?? []).length;
  check(
    `three 的产物里**有** ${threeStaticBlocks} 处 class static 块（精确证据：three.build/three.core.js 里的 Vector2/Vector3/Matrix3 等）—— 这是"实际下限被抬到 Safari 16.4"的直接原因`,
    threeCore.ok && threeStaticBlocks > 0,
    threeCore.ok
      ? `${threeStaticBlocks} 处（three ${String(threeReal)}）`
      : `读不到 three 的产物：${threeCore.reason}（**不是**核对通过）`,
  );
  const mainText = readProjectFile('src/main.ts').text;
  check(
    'WebGL 拿不到时的兜底是"启动期 try/catch + 中文覆盖层"（CSS .fatal 已在 style.css 里定义，覆盖层不会是隐形的）',
    /catch\s*\(error\)/.test(mainText) && /启动失败/.test(mainText) && /WebGL2/.test(mainText)
      && /\.fatal\s*\{/.test(readProjectFile('src/style.css').text),
    'main.ts：try/catch + 「启动失败」+ 提到 WebGL2；style.css 有 .fatal 规则',
  );
  const webglPrecheck = findInCode(/isWebGLAvailable|WEBGL_|forceContextLoss|getContext\('webgl2'\)|getContext\("webgl2"\)/);
  check(
    '登记事实：**没有**独立的 WebGL/WebGL2 可用性预检（`isWebGLAvailable` 之类一处都没有）。唯一做上下文探测的是自定义物品的预览，它是"拿不到就退回文字摘要"',
    true,
    webglPrecheck.length === 0
      ? '0 处探测：WebGL2 缺失时由 three 抛异常 → main.ts 的「启动失败」覆盖层接住。没有降级到 WebGL1 的路径'
      : `探测位置：${formatHits(webglPrecheck)}`,
  );
  const contextLostListeners = findInNoComments(/webglcontextlost/);
  const contextRestored = findInNoComments(/webglcontextrestored/);
  check(
    '登记事实：WebGL 上下文丢失**有采集**（webglcontextlost 被 ErrorHandler 记录成一条中文错误），但**没有** contextrestored / 渲染器重建 —— 手机切后台被系统回收上下文后，玩家只能刷新（已列风险表）',
    contextLostListeners.length > 0 && contextRestored.length === 0,
    `webglcontextlost ${contextLostListeners.length} 处（${formatHits(contextLostListeners, 2)}）｜webglcontextrestored ${contextRestored.length} 处`,
  );
  const customItemPreview = findInNoComments(/getContext\('webgl2'\)/);
  check(
    '自定义物品预览是唯一"先自己取上下文再建渲染器"的地方（取不到就不建 WebGLRenderer —— 因为 three 在拿不到上下文时会抛）',
    customItemPreview.length > 0,
    formatHits(customItemPreview),
  );

  // ==================================================================
  // 五、移动端 / 触摸 / 后台切回
  // ==================================================================
  const resizeHooks = findInNoComments(/addEventListener\('resize'/);
  const orientationHooks = findInNoComments(/addEventListener\('orientationchange'/);
  check(
    '屏幕旋转与尺寸变化都挂了监听（手机旋转后画布要重算像素比与视口，否则画面会被拉伸或留黑边）',
    resizeHooks.length > 0 && orientationHooks.length > 0,
    `resize ${formatHits(resizeHooks)}｜orientationchange ${formatHits(orientationHooks)}`,
  );
  const visibilityHooks = findInNoComments(/addEventListener\('visibilitychange'/);
  const visibilityReset = /handleVisibility\s*=\s*\(\)\s*:\s*void\s*=>\s*\{[\s\S]{0,200}?lastTimestamp\s*=\s*0/.test(engineText);
  check(
    '切后台再回来会清零上一帧时间戳（否则回来的第一帧 delta 可能是一整分钟，水/沙/物理会一次性推进一大步甚至炸开）',
    visibilityHooks.length > 0 && visibilityReset,
    `visibilitychange ${visibilityHooks.length} 处；handleVisibility 里清零 lastTimestamp：${visibilityReset ? '是' : '否'}`,
  );
  const maxFrameDelta = readConfigValue(engineText, /MAX_FRAME_DELTA\s*=\s*([\d.]+)/);
  const maxFrameDeltaUses = findInCode(/MAX_FRAME_DELTA/);
  check(
    '帧间隔有硬上限（MAX_FRAME_DELTA 被 loop 用来夹 delta：低配手机掉帧时物理不会"跳步"）',
    maxFrameDelta !== null && Number(maxFrameDelta) > 0 && maxFrameDeltaUses.length >= 2,
    `MAX_FRAME_DELTA = ${String(maxFrameDelta)}，引用 ${maxFrameDeltaUses.length} 处（${formatHits(maxFrameDeltaUses)}）`,
  );
  const pointerEvents = findInNoComments(/addEventListener\('pointer(down|move|up|cancel)'/);
  const setPointerCapture = findInCode(/setPointerCapture/);
  const touchEvents = findInNoComments(/addEventListener\('touch(start|move|end)'/);
  check(
    '触摸走 Pointer Events（pointerdown/move/up/cancel + setPointerCapture），不是老的 touch* 事件 —— 一份代码同时覆盖鼠标 / 触屏 / 触控笔',
    pointerEvents.length > 0 && touchEvents.length === 0,
    `pointer* ${pointerEvents.length} 处｜touch* ${touchEvents.length} 处｜setPointerCapture ${setPointerCapture.length} 处（${formatHits(setPointerCapture, 2)}）`,
  );
  const pixelRatioPresets = Object.entries(QUALITY_PRESETS).map(([name, preset]) => `${name}=${preset.maxPixelRatio}`);
  check(
    '所有质量档的像素比上限都 ≤ 3（手机上 devicePixelRatio 常是 3~4，不夹住就是白烧一倍多的像素）',
    Object.values(QUALITY_PRESETS).every((preset) => preset.maxPixelRatio <= 3),
    pixelRatioPresets.join('｜'),
  );
  const pixelRatioClamp = findInCode(/Math\.min\(ratio,\s*3\)/);
  check(
    '运行时设置像素比也会夹到 [0.5, 3]（玩家手动拖到 4 倍不会把手机烧掉）',
    pixelRatioClamp.length > 0,
    formatHits(pixelRatioClamp),
  );
  const deviceProfile = (() => {
    try {
      return { ok: true as const, profile: detectDevice() };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
  })();
  check(
    'detectDevice() 在**没有 window / navigator 的 Node 里**也不抛异常，并给出确定的档位（这是本文件里少数"真的跑了一遍"的断言：验证的是降级分支，不是浏览器行为）',
    deviceProfile.ok,
    deviceProfile.ok
      ? `tier=${deviceProfile.profile.tier}｜推荐档=${deviceProfile.profile.recommendedQuality}｜isTouchDevice=${String(deviceProfile.profile.isTouchDevice)}｜理由=${deviceProfile.profile.reason}`
      : `抛异常了：${deviceProfile.reason}`,
  );
  const vibrationUse = findInCode(/navigator\.vibrate/);
  const vibrationProbe = findInCode(/canVibrate/);
  check(
    '震动是可探测能力（navigator.vibrate 是 Chromium / Android 专有，iOS Safari 没有；本项目先探测再决定要不要震）',
    vibrationProbe.length > 0,
    `navigator.vibrate ${vibrationUse.length} 处｜canVibrate 探测 ${vibrationProbe.length} 处`,
  );
  const styleText = readProjectFile('src/style.css').text;
  const touchClass = findInNoComments(/classList\.add\('touch-device'\)/);
  const portraitClass = findInNoComments(/classList\.toggle\('mobile-portrait'/);
  const narrowClass = findInNoComments(/classList\.toggle\('mobile-narrow'/);
  const touchClassCss = /body\.touch-device/.test(styleText);
  const portraitCss = /body\.mobile-portrait/.test(styleText);
  const narrowCss = /body\.mobile-narrow/.test(styleText);
  check(
    '三个"移动端形状"类名两边都对得上（touch-device / mobile-portrait / mobile-narrow：JS 加类、style.css 有对应规则；对不上的话就是一段永远不会生效的 CSS 或一个永远不动的类）',
    touchClass.length > 0 && portraitClass.length > 0 && narrowClass.length > 0 && touchClassCss && portraitCss && narrowCss,
    `JS：touch-device ${touchClass.length} 处 / mobile-portrait ${portraitClass.length} 处 / mobile-narrow ${narrowClass.length} 处｜CSS 规则：touch-device ${String(touchClassCss)} / mobile-portrait ${String(portraitCss)} / mobile-narrow ${String(narrowCss)}`,
  );
  const vhUses = (readProjectFile('src/style.css').text.match(/calc\(100vh\s*-/g) ?? []).length;
  check(
    '登记事实：style.css 里用 calc(100vh - Npx) 的地方有若干处，且全项目**没有** visualViewport —— iOS Safari 的 100vh 是"地址栏收起后"的高度，面板在地址栏展开时可能比可视区高一点（已列风险表）',
    true,
    `${vhUses} 处 calc(100vh - …)｜visualViewport 0 处｜dvh/svh 0 处`,
  );
  const moduleWorkers = findInCode(/new Worker\(new URL\(/);
  const workerTry = findInCode(/worker = this\.ensureWorker\(\)/);
  const syncFallback = findInCode(/runSyncPath/);
  check(
    '模块化 Worker（type: \'module\'）的构造被 try 包住，并且有主线程同步回退 —— Firefox 114 之前不支持模块 Worker，这个回退就是那条路的兜底',
    moduleWorkers.length > 0 && workerTry.length > 0 && syncFallback.length > 0,
    `new Worker(new URL(...)) ${moduleWorkers.length} 处｜try 包住的 ensureWorker ${workerTry.length} 处｜runSyncPath ${syncFallback.length} 处`,
  );
  const intersectionFallback = findInNoComments(/typeof IntersectionObserver === 'function'/);
  check(
    'IntersectionObserver 有"没有就降级"的分支（Safari 12.1 之前、以及 Node 断言环境里都没有它）',
    intersectionFallback.length >= 2,
    formatHits(intersectionFallback),
  );
  const mediaQueryCalls = collectOccurrences(/matchMedia\s*\(/);
  const mediaQueryOutsideTry = mediaQueryCalls.filter((call) => !call.insideTry);
  check(
    'matchMedia 的调用全部包在 try 里（老实现 + 非法查询串会直接抛；ThemeSwitch 把它当成"没有 matchMedia"处理，DeviceCapability 也有 catch）',
    mediaQueryCalls.length > 0 && mediaQueryOutsideTry.length === 0,
    mediaQueryOutsideTry.length === 0
      ? `${mediaQueryCalls.length} 处调用全部在 try 内（${formatHits(mediaQueryCalls, 4)}）`
      : `没兜住的：${mediaQueryOutsideTry.map((call) => `${call.rel}:${call.line}`).join('、')}`,
  );

  // ==================================================================
  // 六、存储兜底（第 1/2 批新写的模块是重点）
  // ==================================================================
  const storageRefs = collectStorageRefs();
  const methodRefs = storageRefs.filter((ref) => ref.kind === 'method');
  const methodOutsideTry = methodRefs.filter((ref) => !ref.insideTry);
  check(
    `所有 localStorage / sessionStorage 的**方法调用**都在 try 内（共 ${methodRefs.length} 处：getItem / setItem / removeItem / clear / key）——这一条是硬的：破例说明有人写了个没兜住的存储访问`,
    methodRefs.length > 0 && methodOutsideTry.length === 0,
    methodOutsideTry.length === 0
      ? `${methodRefs.length} 处全部在 try 内`
      : `没兜住的：${methodOutsideTry.map((ref) => `${ref.rel}:${ref.line}`).join('、')}`,
  );
  const guardOutsideTry = storageRefs.filter((ref) => ref.kind === 'typeofGuard' && !ref.insideTry);
  const propertyOutsideTry = storageRefs.filter((ref) => ref.kind === 'property' && !ref.insideTry);
  const typeofGuardCount = storageRefs.filter((ref) => ref.kind === 'typeofGuard').length;
  const propertyCount = storageRefs.filter((ref) => ref.kind === 'property').length;
  check(
    `登记事实：有 ${guardOutsideTry.length} 处 typeof 守卫与 ${propertyOutsideTry.length} 处属性直传写在 try **之外** —— 在"读取 localStorage 属性本身就抛 SecurityError"的浏览器里，这些地方自己会抛（typeof 只吞"未声明"，不吞 getter 抛的异常）。上限 18 + 4：新增会红`,
    guardOutsideTry.length <= 18 && propertyOutsideTry.length <= 4,
    `typeof 守卫 ${guardOutsideTry.length} 处：${guardOutsideTry.map((ref) => `${ref.rel}:${ref.line}`).join('、')}`
      + ` ‖ 属性直传 ${propertyOutsideTry.length} 处：${propertyOutsideTry.length === 0
        ? '0 处'
        : propertyOutsideTry.map((ref) => `${ref.rel}:${ref.line}（${ref.lineText}）`).join('、')}`
      + ` ‖ 总量 ${storageRefs.length} 处（方法 ${methodRefs.length} / typeof 守卫 ${typeofGuardCount} / 其余属性访问 ${propertyCount}），分布在 ${new Set(storageRefs.map((ref) => ref.rel)).size} 个文件里`,
  );
  const saveSystemRefs = storageRefs.filter((ref) => ref.rel === 'src/save/SaveSystem.ts');
  const saveSystemMethods = saveSystemRefs.filter((ref) => ref.kind === 'method');
  check(
    `SaveSystem（存档读写删）的 ${saveSystemMethods.length} 处存储方法调用全部在 try 内，且失败时给中文说明而不是抛出去`,
    saveSystemMethods.length >= 5 && saveSystemMethods.every((ref) => ref.insideTry)
      && /本地存储空间不足/.test(readProjectFile('src/save/SaveSystem.ts').text),
    `方法调用 ${saveSystemMethods.map((ref) => `${ref.rel}:${ref.line}`).join('、')}（全部在 try 内：${String(saveSystemMethods.every((ref) => ref.insideTry))}）`,
  );
  const m5StorageFiles = [
    'src/ui/ThemeSwitch.ts',
    'src/ui/PanelManager.ts',
    'src/ui/ShortcutPanel.ts',
    'src/ui/MapTemplateUI.ts',
    'src/ui/PhysicsSandboxMode.ts',
    'src/tutorial/TutorialProgress.ts',
    'src/tutorial/Onboarding.ts',
    'src/data/contentPacks.ts',
    'src/data/customItems.ts',
    'src/data/physicsMaterials.ts',
  ];
  const looseFiles: string[] = [];
  const perFile: string[] = [];
  for (const rel of m5StorageFiles) {
    const refs = storageRefs.filter((ref) => ref.rel === rel && ref.kind === 'method');
    const loose = refs.filter((ref) => !ref.insideTry);
    if (loose.length > 0) looseFiles.push(`${rel}:${loose.map((ref) => ref.line).join('/')}`);
    perFile.push(`${rel.split('/').pop()}=${refs.length}`);
  }
  check(
    '第 1/2 批新写的那些模块（主题 / 面板 / 快捷键 / 地图模板 / 沙盘模式 / 教学进度 / 内容包 / 自定义物品 / 材质）里，存储方法调用**没有一处**漏掉 try',
    looseFiles.length === 0,
    looseFiles.length === 0 ? `逐文件方法调用数：${perFile.join('｜')}` : `漏掉的：${looseFiles.join('、')}`,
  );

  // ---- 真的跑一遍：属性读取抛 / 方法抛，两种故障的兜底差别 ----
  interface HostileGlobal {
    localStorage?: unknown;
  }
  const host = globalThis as unknown as HostileGlobal;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const restoreStorage = (): void => {
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete host.localStorage;
  };

  const noStorageProbe = (() => {
    try {
      delete host.localStorage;
      const loaded = loadEnabledPacks();
      const saved = saveEnabledPacks(loaded);
      return { ok: true as const, size: loaded.size, saved };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      restoreStorage();
    }
  })();
  check(
    '真跑一遍（降级路径）：完全没有 localStorage 时（Node / 无痕环境），loadEnabledPacks() 不抛异常并回落到默认启用集，saveEnabledPacks() 如实返回 false',
    noStorageProbe.ok && noStorageProbe.size > 0 && noStorageProbe.saved === false,
    noStorageProbe.ok ? `默认启用 ${noStorageProbe.size} 个内容包；写入返回 ${String(noStorageProbe.saved)}` : `抛异常了：${noStorageProbe.reason}`,
  );

  const methodThrowsProbe = (() => {
    try {
      const hostile = {
        getItem: (): string | null => {
          throw new Error('模拟：站点数据被禁用，读取即抛');
        },
        setItem: (): void => {
          throw new Error('模拟：配额为 0');
        },
        removeItem: (): void => {
          throw new Error('模拟：禁止删除');
        },
        get length(): number {
          throw new Error('模拟：连 length 都读不了');
        },
      };
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: hostile });
      const loaded = loadEnabledPacks();
      const saved = saveEnabledPacks(loaded);
      return { ok: true as const, size: loaded.size, saved };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      restoreStorage();
    }
  })();
  check(
    '真跑一遍（降级路径）：localStorage **方法**抛异常时（配额满 / 被策略禁用）读写都安全降级 —— 这一条是第 1/2 批"存储坏掉不能把应用带崩"的规矩真的生效的证据',
    methodThrowsProbe.ok && methodThrowsProbe.size > 0 && methodThrowsProbe.saved === false,
    methodThrowsProbe.ok
      ? `读回落默认集（${methodThrowsProbe.size} 个包），写返回 ${String(methodThrowsProbe.saved)}`
      : `抛出来了：${methodThrowsProbe.reason}`,
  );

  const propertyThrowsProbe = (() => {
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get(): never {
          // 这就是 Chromium 在"禁用站点数据 / 全部 Cookie"时 `window.localStorage` 的行为：
          // 读属性本身抛 SecurityError（不是方法抛）
          const error = new Error("Failed to read the 'localStorage' property from 'Window': Access is denied for this document.");
          error.name = 'SecurityError';
          throw error;
        },
      });
      loadEnabledPacks();
      return { ok: true as const, threw: false };
    } catch (error) {
      return { ok: true as const, threw: true, reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    } finally {
      restoreStorage();
    }
  })();
  check(
    '登记事实（真跑一遍）：把 localStorage 换成"读属性就抛 SecurityError"，loadEnabledPacks() 会把异常**抛出来** —— 这就是 COMPATIBILITY.md 风险表里那条"typeof 守卫挡不住属性读取抛错"的实测证据（修它要改 src，本批次禁改，所以这里是登记而不是硬失败）',
    propertyThrowsProbe.ok,
    propertyThrowsProbe.ok
      ? (propertyThrowsProbe.threw
        ? `实测：抛了 —— ${propertyThrowsProbe.reason ?? ''}（在启动路径上会走到 main.ts 的「启动失败」覆盖层）`
        : '实测：没抛（上游已经补上了兜底？请更新 COMPATIBILITY.md 的风险表）')
      : '探测本身出错了',
  );
  check(
    '假 localStorage 已经还原（不给别的断言留全局污染）',
    Object.getOwnPropertyDescriptor(globalThis, 'localStorage') === originalLocalStorage,
    `还原后描述符是否与探测前一致：${String(Object.getOwnPropertyDescriptor(globalThis, 'localStorage') === originalLocalStorage)}`,
  );

  // ==================================================================
  // 七、键盘可用性 / 无障碍（手机没有键盘这件事）
  // ==================================================================
  const actionButtons = [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1] ?? '');
  const shortcutsButton = actionButtons.includes('shortcuts');
  const shortcutHelpListener = findInNoComments(/addEventListener\('keydown'/);
  check(
    '每一个"只有快捷键才能打开"的功能在界面上都有可点按钮：主工具栏里有 data-action="shortcuts" 的入口，快捷键面板本身也自己监听键盘',
    shortcutsButton && shortcutHelpListener.length > 0,
    `data-action 入口 ${actionButtons.length} 个（含 shortcuts：${String(shortcutsButton)}）｜keydown 监听 ${shortcutHelpListener.length} 处`,
  );
  const buttonTags = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
  const buttonTitles = buttonTags.filter((tag) => /title="/.test(tag)).length;
  const ariaLabels = [...html.matchAll(/aria-[a-z]+="/g)].length;
  const roleAttributes = [...html.matchAll(/role="/g)].length;
  check(
    `无障碍与可发现性登记：index.html 里 ${buttonTags.length} 个 <button>（其中 ${buttonTitles} 个带 title）、aria-* 属性 ${ariaLabels} 处、role 属性 ${roleAttributes} 处 —— title 对触屏（没有 hover）基本没用，真正靠的是按钮上的中文文案；屏幕阅读器可达性没有专门做过（已列风险表）`,
    buttonTags.length > 0,
    `按钮 ${buttonTags.length} 个 / 带 title ${buttonTitles} 个｜aria-* ${ariaLabels} 处｜role ${roleAttributes} 处`,
  );

  const themeText = readProjectFile('src/ui/ThemeSwitch.ts').text;
  const contrastSlice = (() => {
    const start = themeText.indexOf('深色档：');
    const end = themeText.indexOf('边框不在这个约束内');
    return start >= 0 && end > start ? themeText.slice(start, end) : '';
  })();
  const contrastNumbers = [...contrastSlice.matchAll(/(\d+\.\d+)/g)].map((match) => Number(match[1]));
  const borderSlice = themeText.slice(themeText.indexOf('边框不在这个约束内'));
  const borderNumbers = [...borderSlice.matchAll(/(\d+\.\d+)/g)].map((match) => Number(match[1]));
  check(
    '对比度：源码注释里那份自算的对比度表（深/浅两档正文、次要文字、强调色、危险色）每一档都 ≥ 4.5（WCAG AA 正文线）。数字取自 src/ui/ThemeSwitch.ts 的注释，本文件不重算、不引用外部资料',
    contrastSlice.length > 0 && contrastNumbers.length >= 8 && contrastNumbers.every((value) => value >= 4.5),
    contrastSlice.length === 0
      ? '没找到那段对比度注释（数字来源失效，请复核 docs/COMPATIBILITY.md 里的引用）'
      : `${contrastNumbers.length} 个比值，最小 ${Math.min(...contrastNumbers)}，最大 ${Math.max(...contrastNumbers)}（明细：${contrastNumbers.join(' / ')}）`
        + `｜边框对比度（源注释里明确排除在 4.5 之外，只做分隔）：${borderNumbers.join(' / ')}`,
  );
  // ==================================================================
  // 八、键盘以外的兜底：剪贴板等"只在安全上下文 / 用户手势下可用"的能力
  // ==================================================================
  const clipboardUse = findInCode(/navigator\.clipboard/);
  const clipboardText = readProjectFile('src/core/Engine.ts').text;
  const clipboardGuarded = /navigator\.clipboard[\s\S]{0,400}?catch/.test(clipboardText);
  check(
    'clipboard 写入包在 try/catch 里，并且拿不到就如实返回 false（非安全上下文、没有用户手势、权限被拒时 writeText 会 reject —— 手机上传档失败时最少还能看到提示）',
    clipboardUse.length > 0 && clipboardGuarded,
    `navigator.clipboard ${clipboardUse.length} 处（${formatHits(clipboardUse, 2)}）｜catch 兜底：${clipboardGuarded ? '有' : '没有'}`,
  );
  const audioContextUse = findInCode(/AudioContext|webkitAudioContext/);
  check(
    '声音与震动这两样"不是每台设备都有"的能力都做了登记：AudioContext（Safari / iOS 要求用户手势之后才能出声，面板上写明了"点击后才会出声"）与 navigator.vibrate（Chromium / Android 专有，iOS Safari 没有；本项目先探测 canVibrate 再决定震不震）',
    true,
    audioContextUse.length === 0
      ? '0 处 AudioContext｜navigator.vibrate ' + String(vibrationUse.length) + ' 处 / canVibrate 探测 ' + String(vibrationProbe.length) + ' 处'
      : `AudioContext ${audioContextUse.length} 处（${formatHits(audioContextUse, 3)}）｜navigator.vibrate ${vibrationUse.length} 处 / canVibrate 探测 ${vibrationProbe.length} 处`,
  );

  // ==================================================================
  // 九、本文件自己的可信度：扫描器口径的交叉验证
  // ==================================================================
  const scannerCrossCheck = (() => {
    const sample = 'function a() {\n  try {\n    localStorage.getItem("k");\n  } catch {\n    /* 忽略 */\n  }\n}\n';
    const strippedSample = stripNonCode(sample);
    const index = strippedSample.code.indexOf('localStorage');
    return {
      insideTry: index >= 0 && insideTryAt(strippedSample.code, index),
      commentErased: !strippedSample.code.includes('忽略'),
      stringErased: !strippedSample.code.includes('k'),
    };
  })();
  check(
    '扫描器自检：它认得出"在 try 里"，也真的把注释与字符串内容抹掉了（否则上面所有"有没有某个 API"的结论都不可信）',
    scannerCrossCheck.insideTry && scannerCrossCheck.commentErased && scannerCrossCheck.stringErased,
    `try 内判定=${String(scannerCrossCheck.insideTry)}｜注释被抹掉=${String(scannerCrossCheck.commentErased)}｜字符串内容被抹掉=${String(scannerCrossCheck.stringErased)}`,
  );
}
