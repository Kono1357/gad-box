/**
 * 损坏存档导出（M5 第 1 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么要有这个东西
 * ────────────────────────────────────────────────────────────
 * 本地存档坏掉时，现在的代码只能告诉玩家"本地存档已损坏（JSON 解析失败）"
 * （见 `save/SaveSystem.ts` 的 `loadFromStorage`）。这句话对玩家毫无帮助，对开发者也没有线索：
 * 存档已经被自动保存覆盖掉了，出问题的那些字符**再也拿不回来**。
 * 所以安全模式的第一个动作是"先把它导出来"：把原始文本原样存一份到文件里，
 * 玩家可以把文件发出来，坏在哪、怎么坏的都还有得查。
 *
 * ────────────────────────────────────────────────────────────
 * "绝不修改原始数据"是靠**结构**保证的，不是靠自觉
 * ────────────────────────────────────────────────────────────
 * `buildCorruptSaveExport()` 是纯函数，签名只收一个**字符串**（调用方从 localStorage 读出来的原始文本）：
 * 它手上根本没有 storage 句柄，所以它在物理上就不可能删除、覆盖或"顺手修复"原数据。
 * 想改原数据只能由调用方自己做，与这里无关。
 * 下面 `raw.text` 是那份字符串的**副本内容**（字符串在 JS 里本来就不可变，这里只是把它装进报告）。
 *
 * 另一个刻意的取舍：**默认不截断原文**。损坏的存档正是最需要"逐字符原样"的证据，
 * 截断过的证据没法用来定位解析失败在哪一字节。要限制体积的调用方显式传 `maxRawChars`，
 * 截断会被如实记在 `raw.truncated` / `notes` 里，不会被说成"这是完整的"。
 */

import { SAVE_CONFIG } from '../config';

/** 报告的格式标识与版本（导入方据此判断字段含义有没有变） */
export const CORRUPT_SAVE_FORMAT = 'god-sandbox/corrupt-save-export';
export const CORRUPT_SAVE_FORMAT_VERSION = 1;

/** 从本地存储读出来的原始现场（调用方负责把这几项凑齐，本模块不碰存储） */
export interface CorruptSaveInput {
  /** 从哪个键读的（`god-sandbox-save-v3` 等） */
  key: string;
  /** `getItem` 的返回值原样传进来（`null` = 键不存在） */
  raw: string | null;
  /** 读存储时抛出的异常（`String(error)`）；没抛就是 `null` */
  readError?: string | null;
  /** 调用方已经解析过一次时，把解析错误传进来；不传则本模块自己解析一次并记录原因 */
  parseError?: string | null;
  /** 导出时间戳，默认 `Date.now()`。可注入是为了断言能拿到确定的数字 */
  exportedAt?: number;
  /** 原文最多保留多少字符，默认不截断（`Number.POSITIVE_INFINITY`） */
  maxRawChars?: number;
}

/** 从（可能是坏的）存档里能读出来的版本信息；读不出来的字段一律 `null` */
export interface CorruptSaveVersionInfo {
  saveVersion: number | null;
  worldSize: string | null;
  seed: number | null;
  mapId: string | null;
  /** 存档自己记的保存时间 */
  savedAt: number | null;
  sizeX: number | null;
  sizeY: number | null;
  sizeZ: number | null;
  chunkCount: number | null;
  buildingCount: number | null;
  /** 是否是 M1 的旧格式（chunks 里是 `data` 字符串而不是 `voxels`） */
  legacyShape: boolean;
}

export interface CorruptSaveExport {
  format: string;
  formatVersion: number;
  exportedAt: number;
  exportedAtIso: string;
  storageKey: string;
  /** 导出时程序支持的存档版本（判断"存档太新"要看它）。取不到就是 null 并说明 */
  supportedSaveVersion: number | null;
  raw: {
    /** 原始文本的副本内容（`null` 表示键不存在/读失败） */
    text: string | null;
    /** 原文总长度（字符数，**不是字节数**：中文一个字在 UTF-8 里占 3 字节，说字节会小看体积） */
    lengthChars: number;
    truncated: boolean;
    keptChars: number;
    /** FNV-1a 32 位校验和，用来证明"这份副本和原文逐字符一致"；原文为 null 时也是 null */
    checksumFnv1a32: string | null;
  };
  /** 读取/解析时出的错（原样保留错误消息，**不翻译**：翻译过的报错搜不到） */
  errors: { read: string | null; parse: string | null };
  version: CorruptSaveVersionInfo;
  diagnosis: {
    /** 能不能当作一份"正常可读的存档"（能解析、有 version、有 chunks 数组） */
    readable: boolean;
    /** 中文问题清单（给人看的，按发现顺序排列） */
    problems: string[];
  };
  notes: string[];
}

/**
 * 构造导出报告（纯函数：只读输入，不抛异常，不碰存储）。
 *
 * 任何异常都必须在内部消化掉：这个函数本身是在"存档已经坏了"的路径上被调用的，
 * 它自己要是在这里抛异常，玩家连最后一点线索都拿不到。
 */
export function buildCorruptSaveExport(input: CorruptSaveInput): CorruptSaveExport {
  const rawText = typeof input.raw === 'string' ? input.raw : null;
  const max = normalizeMaxRawChars(input.maxRawChars);
  const truncated = rawText !== null && rawText.length > max;
  const kept = rawText === null ? null : truncated ? rawText.slice(0, max) : rawText;

  const problems: string[] = [];
  const readError = typeof input.readError === 'string' && input.readError.length > 0 ? input.readError : null;
  // 读失败与"存档坏了"是两件事，分开记：读失败时 localStorage 里可能一切正常，
  // 问题出在隐私模式 / 存储被禁用，这时真正该做的排查方向完全不同。
  if (readError) problems.push(`读取本地存储时抛出了异常（此时任何键都读不到，多半是隐私模式或存储被禁用）：${readError}`);
  if (rawText === null) problems.push(`键 ${input.key} 读不到内容（localStorage.getItem 返回 null）：本地根本没有这份存档。`);
  else if (rawText.length === 0) problems.push(`键 ${input.key} 的值是空字符串：写入过程被中断过（写了一半没写完）。`);

  // 解析：优先用调用方给的错误（它可能是在真正的读档流程里捕获的，上下文更准），
  // 没给就自己解析一次 —— 报告里必须有"为什么这份存档被认为是坏的"，否则它只是一坨字符串。
  let parseError = typeof input.parseError === 'string' && input.parseError.length > 0 ? input.parseError : null;
  let parsed: unknown = null;
  let parsedOk = false;
  if (rawText !== null && rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
      parsedOk = true;
    } catch (error) {
      const own = error instanceof Error ? error.message : String(error);
      if (!parseError) parseError = own;
    }
  }
  if (parseError) problems.push(`JSON 解析失败：${parseError}`);

  const version = readVersionInfo(parsed, parsedOk);

  let readable = false;
  if (parsedOk) {
    if (!isPlainObject(parsed)) {
      problems.push(`JSON 能解析，但顶层不是对象（是 ${describeJsonType(parsed)}）：存档数据整体被截断或改写成了别的形状。`);
    } else if (version.saveVersion === null) {
      problems.push('缺少 version 字段（数字）：无法判断该用哪一版格式去读。');
    } else if (version.saveVersion > SAVE_CONFIG.version) {
      problems.push(
        `存档版本 ${version.saveVersion} 高于当前程序支持的 ${SAVE_CONFIG.version}：`
        + '多半是用新版本存的档、又用旧版本打开了（GitHub Pages 上回退版本时很常见）。',
      );
    } else if (version.chunkCount === null) {
      problems.push('缺少 chunks 数组：即使版本号对得上，也没有任何地形数据可读。');
    } else {
      readable = true;
    }
  }

  const notes = [
    '导出的是**副本**：本模块只接收读出来的字符串，没有任何存储句柄，因此不可能修改本地存储里的原数据。',
    '这里**不做任何修复**：坏掉的字节被原样保留，正是为了让开发者能看到它坏在哪。',
  ];
  if (truncated) {
    notes.push(
      `原文已按调用方要求截断：只保留前 ${max} 字符（原文 ${rawText?.length ?? 0} 字符），`
      + '被截掉的部分在 raw.text 里**不存在**，排查时请注意这一点。',
    );
  } else if (rawText !== null) {
    notes.push('原文**未截断**：raw.text 与 localStorage 里的值逐字符相同。');
  }
  if (rawText === null) notes.push('raw.text 为 null：读不到原文，报告里只剩下"读失败"这个事实本身。');
  notes.push('checksumFnv1a32 是对原文（UTF-16 码元逐个）算的 32 位 FNV-1a，它不是加密哈希，只用来核对副本与原文字符是否一致。');

  const exportedAt = typeof input.exportedAt === 'number' && Number.isFinite(input.exportedAt) ? input.exportedAt : Date.now();

  return {
    format: CORRUPT_SAVE_FORMAT,
    formatVersion: CORRUPT_SAVE_FORMAT_VERSION,
    exportedAt,
    exportedAtIso: new Date(exportedAt).toISOString(),
    storageKey: input.key,
    supportedSaveVersion: typeof SAVE_CONFIG.version === 'number' ? SAVE_CONFIG.version : null,
    raw: {
      text: kept,
      lengthChars: rawText === null ? 0 : rawText.length,
      truncated,
      keptChars: kept === null ? 0 : kept.length,
      checksumFnv1a32: rawText === null ? null : checksumFnv1a32(rawText),
    },
    errors: { read: readError, parse: parseError },
    version,
    diagnosis: { readable, problems },
    notes,
  };
}

/** 报告 → 可下载的 JSON 字符串。缩进 2 空格：这份文件是给人看的，不是给机器省的 */
export function corruptSaveExportJson(payload: CorruptSaveExport): string {
  return JSON.stringify(payload, null, 2);
}

/** 建议的文件名：带键名与时间戳，玩家连着导两次也不会互相覆盖 */
export function corruptSaveExportFileName(payload: CorruptSaveExport): string {
  const safeKey = payload.storageKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  const stamp = new Date(payload.exportedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `god-sandbox-corrupt-save-${safeKey}-${stamp}.json`;
}

/** 一行中文说明（面板显示：导出前告诉玩家"会导出什么、原数据会不会动"） */
export function describeCorruptSaveExport(payload: CorruptSaveExport): string {
  const size = payload.raw.text === null ? '读不到原文' : `${payload.raw.lengthChars} 字符${payload.raw.truncated ? '（已截断）' : ''}`;
  const state = payload.diagnosis.readable ? '还能被当作存档读出来' : '已确认读不出来';
  return (
    `损坏存档导出：键 ${payload.storageKey}，${size}，${state}，`
    + `发现 ${payload.diagnosis.problems.length} 处问题；导出的只是副本，本地存储里的原数据不会被改动。`
  );
}

/**
 * 触发浏览器下载（要在 DOM 里跑）。
 *
 * Node / 无 DOM 环境下**如实返回失败**，并告诉调用方改走 `corruptSaveExportJson()` 拿字符串 ——
 * 这里绝不假装成功（"点了导出但什么都没下载下来"比报错更让人摸不着头脑）。
 *
 * `chars` 是字符数不是字节数：与 `SaveSystem.exportToFile` 的口径一致（它也用 `text.length`），
 * 但这个数字确实不等于文件字节数（中文一个字 3 字节），所以字段名就叫 chars。
 */
export function downloadCorruptSaveExport(payload: CorruptSaveExport): {
  ok: boolean;
  message: string;
  chars: number | null;
} {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function') {
    return {
      ok: false,
      message: '当前环境没有 document / Blob / URL.createObjectURL（Node 里无法下载）：请改用 corruptSaveExportJson() 取字符串自行保存。',
      chars: null,
    };
  }
  try {
    const text = corruptSaveExportJson(payload);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = corruptSaveExportFileName(payload);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 立刻 revoke 会让部分浏览器来不及开始下载，所以延迟一下（与 SaveSystem.exportToFile 同一做法）
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true, message: `已导出损坏存档的副本（${text.length} 字符）`, chars: text.length };
  } catch (error) {
    return {
      ok: false,
      message: `导出失败：${error instanceof Error ? error.message : String(error)}`,
      chars: null,
    };
  }
}

// ---------------------------------------------------------------- 内部

function normalizeMaxRawChars(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) return Number.POSITIVE_INFINITY;
  return Math.floor(requested);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON 值的类型名（中文），用来把"顶层不是对象"这件事说具体 */
function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value === 'object' ? '对象' : typeof value;
}

/** 字段取值：类型不对就是 `null`，不做任何猜测性转换（"3" 不该被当成 3） */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 从解析出来的（可能是坏的）对象里尽力读出关键字段。
 *
 * 每一项都单独判类型：坏存档最常见的样子就是"大部分字段还在，某一个字段变成了 null/字符串"，
 * 能读出多少就记多少，读不出的那项记 `null`（不编造默认值）。
 */
function readVersionInfo(parsed: unknown, parsedOk: boolean): CorruptSaveVersionInfo {
  const empty: CorruptSaveVersionInfo = {
    saveVersion: null,
    worldSize: null,
    seed: null,
    mapId: null,
    savedAt: null,
    sizeX: null,
    sizeY: null,
    sizeZ: null,
    chunkCount: null,
    buildingCount: null,
    legacyShape: false,
  };
  if (!parsedOk || !isPlainObject(parsed)) return empty;

  const chunks = Array.isArray(parsed.chunks) ? parsed.chunks : null;
  const buildings = Array.isArray(parsed.buildings) ? parsed.buildings : null;
  const firstChunk = chunks && chunks.length > 0 && isPlainObject(chunks[0]) ? chunks[0] : null;

  return {
    saveVersion: numberOrNull(parsed.version),
    worldSize: stringOrNull(parsed.worldSize),
    seed: numberOrNull(parsed.seed),
    mapId: stringOrNull(parsed.mapId),
    savedAt: numberOrNull(parsed.savedAt),
    sizeX: numberOrNull(parsed.sizeX),
    sizeY: numberOrNull(parsed.sizeY),
    sizeZ: numberOrNull(parsed.sizeZ),
    chunkCount: chunks ? chunks.length : null,
    buildingCount: buildings ? buildings.length : null,
    // v1 的区块是 { cx, cz, data }，没有 voxels 字段
    legacyShape: firstChunk !== null && typeof firstChunk.data === 'string' && firstChunk.voxels === undefined,
  };
}

/**
 * FNV-1a 32 位校验和（对 UTF-16 码元逐个算）。
 *
 * 用 `Math.imul` 而不是普通乘法：32 位整数相乘的结果超过 2^53 会丢精度，
 * 那样算出来的校验和虽然"看起来是个数字"，但不可复现 —— 换个引擎就对不上。
 * 它**不是加密哈希**，只用来核对"这份副本和被读出来的原文是不是同一串字符"。
 */
export function checksumFnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
