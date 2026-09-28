/**
 * 「生成预览 + 地图模板面板」的断言（M4 补充 4 / 补充 5）。
 *
 * 跑法（含可运行的入口）：
 *   npx esbuild scripts/checks/preview.run.ts --bundle --format=esm --platform=node \
 *     --outfile=.verify/preview.mjs && node .verify/preview.mjs
 *
 * 这份断言刻意写成 `runPreviewChecks(check)` 而不是自带 console/process.exit：
 * 这样它既能被单独跑（preview.run.ts），也能被主验证脚本收进去共用同一个计数。
 *
 * ────────────────────────────────────────────────────────────
 * 覆盖范围里**没有**的东西（别误以为测过了）
 * ────────────────────────────────────────────────────────────
 * - 真实 canvas 的像素输出：Node 下没有 canvas，这里用一个**记录调用的假 ctx**
 *   验证「画了什么」（fillRect 次数、有没有写「近似预览」），不验证像素长什么样；
 * - `MapTemplateUI` 的 DOM 分支：Node 里没有 document，测的是 container=null 的
 *   无 DOM 模式（状态、校验、提交、回滚降级都在这一模式下是真的在跑）。
 *   画卡片/滑杆那段只能靠浏览器里手点 —— 想覆盖它就得引 jsdom，而本轮不许加依赖。
 */

import {
  getMapTemplate,
  MAP_TEMPLATES,
  TEMPLATE_PARAM_LIMITS,
  validateTemplateParams,
} from '../../src/data/mapTemplates';
import { getVoxelId } from '../../src/data/voxelTypes';
import {
  buildPreview,
  describePreview,
  renderPreviewCanvas,
  PREVIEW_DEFAULT_RESOLUTION,
  PREVIEW_MAX_RESOLUTION,
  PREVIEW_MIN_RESOLUTION,
  type PreviewData,
  type PreviewRequest,
} from '../../src/world/GenerationPreview';
import {
  MapTemplateUI,
  type MapTemplateUIHandlers,
} from '../../src/ui/MapTemplateUI';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/** 断言里用到的常量：从被测代码里 import，而不是在这里再抄一份范围 */
const RESOLUTION_LIMITS = {
  min: PREVIEW_MIN_RESOLUTION,
  max: PREVIEW_MAX_RESOLUTION,
  default: PREVIEW_DEFAULT_RESOLUTION,
};

/** 耗时尽量用 performance.now()（单调递增，不会被系统时间调整影响） */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 逐字节比较两个 TypedArray 的底层数据（Float32Array / Uint8Array 都要能比） */
type PreviewTypedArray = Float32Array | Uint8Array;

function typedArrayEquals(a: PreviewTypedArray, b: PreviewTypedArray): boolean {
  if (a.length !== b.length) return false;
  const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] !== bv[i]) return false;
  }
  return true;
}

function countByteDifferences(a: PreviewTypedArray, b: PreviewTypedArray): number {
  let diff = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff + Math.abs(a.length - b.length);
}

/** 至少含一个汉字（用来判「中文文案」） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 跑一段可能抛异常的代码，返回「有没有抛」而不是让整份断言炸掉 */
function noThrow(fn: () => void): { ok: boolean; error: string } {
  try {
    fn();
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

interface FakeCanvasRecord {
  texts: string[];
  fillRects: number;
  strokeRects: number;
  dashCalls: number;
  transforms: number;
}

/**
 * 假画布：`withContext = false` 时 `getContext()` 返回 null —— 这正是 Node / 无 canvas 环境
 * （以及浏览器里 canvas 被回收时）的形态，`renderPreviewCanvas` 必须安全返回。
 */
function makeFakeCanvas(
  withContext: boolean,
  clientWidth = 96,
): { canvas: HTMLCanvasElement; record: FakeCanvasRecord } {
  const record: FakeCanvasRecord = { texts: [], fillRects: 0, strokeRects: 0, dashCalls: 0, transforms: 0 };
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    setTransform: (): void => {
      record.transforms += 1;
    },
    clearRect: (): void => undefined,
    fillRect: (): void => {
      record.fillRects += 1;
    },
    strokeRect: (): void => {
      record.strokeRects += 1;
    },
    setLineDash: (): void => {
      record.dashCalls += 1;
    },
    fillText: (text: string): void => {
      record.texts.push(text);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    clientWidth,
    getContext: (): unknown => (withContext ? ctx : null),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, record };
}

/** 预览一次的计时（同一份 request 反复跑，供性能断言用） */
function timePreview(request: PreviewRequest): number {
  const started = now();
  buildPreview(request);
  return now() - started;
}

// ------------------------------------------------------------------ 极简 DOM 桩
//
// Node 里没有 document，所以 `MapTemplateUI` 的建界面分支（卡片 / 滑杆 / 按钮 / 缩略图懒加载）
// 平时根本跑不到。这里手搓一个**刚好够用**的 DOM 桩来覆盖那条分支，而不是引 jsdom
// （本轮不许加依赖）。它能证明的是：「这些节点被建出来了、这些状态下按钮真的被禁用了、
// 点击真的走到了 handler、懒加载真的没有提前算」。它**不能**证明浏览器里的真实布局与样式 ——
// 那两样只能靠人眼在页面上看，这一点必须说清楚，免得后人把这些断言当成了 UI 验收。

interface StubNode {
  tagName: string;
  parent: StubNode | null;
  children: StubNode[];
  style: Record<string, string>;
  dataset: Record<string, string>;
  handlers: Map<string, EventListener[]>;
  textContent: string;
  value: string;
  type: string;
  min: string;
  max: string;
  step: string;
  disabled: boolean;
  title: string;
  width: number;
  height: number;
  clientWidth: number;
  attributes: Map<string, string>;
  appendChild(child: StubNode): StubNode;
  addEventListener(type: string, handler: EventListener): void;
  removeEventListener(type: string, handler: EventListener): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  closest(selector: string): StubNode | null;
  /** 模拟派发事件（桩自己的方法，不是 DOM 的） */
  dispatch(type: string): void;
}

interface StubDom {
  document: Document;
  root: StubNode;
  canvases: { node: StubNode; record: FakeCanvasRecord }[];
  walk(predicate: (node: StubNode) => boolean): StubNode[];
  byText(text: string): StubNode | undefined;
}

/** 造一个节点。方法直接装在节点上（不是原型链）—— 桩要的是「够用」，不是完整 DOM */
function makeStubNode(tagName: string): StubNode {
  const node: StubNode = {
    tagName,
    parent: null,
    children: [],
    style: {},
    dataset: {},
    handlers: new Map(),
    textContent: '',
    value: '',
    type: '',
    min: '',
    max: '',
    step: '',
    disabled: false,
    title: '',
    width: 0,
    height: 0,
    clientWidth: 0,
    attributes: new Map(),
    appendChild: (child: StubNode): StubNode => {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    addEventListener: (type: string, handler: EventListener): void => {
      const list = node.handlers.get(type) ?? [];
      list.push(handler);
      node.handlers.set(type, list);
    },
    removeEventListener: (type: string, handler: EventListener): void => {
      const list = node.handlers.get(type) ?? [];
      node.handlers.set(
        type,
        list.filter((item) => item !== handler),
      );
    },
    setAttribute: (name: string, value: string): void => {
      node.attributes.set(name, value);
    },
    getAttribute: (name: string): string | null => node.attributes.get(name) ?? null,
    // 只支持面板真正用到的那一种选择器（[data-xxx] 属性存在性），够用即可
    closest: (selector: string): StubNode | null => {
      const match = /^\[([a-zA-Z-]+)\]$/.exec(selector);
      let current: StubNode | null = node;
      while (current) {
        if (match) {
          const camel = match[1]!.replace(/-([a-z])/g, (_all: string, chr: string) => chr.toUpperCase());
          if ((current.dataset as Record<string, string | undefined>)[camel] !== undefined) return current;
        }
        current = current.parent;
      }
      return null;
    },
    dispatch: (type: string): void => {
      for (const handler of node.handlers.get(type) ?? []) {
        handler({ target: node } as unknown as Event);
      }
    },
  };
  return node;
}

/** 造一个「够 UI 用」的 document：createElement / canvas + 记录调用的 2d ctx */
function makeStubDom(): StubDom {
  const canvases: { node: StubNode; record: FakeCanvasRecord }[] = [];
  const root = makeStubNode('div');
  root.clientWidth = 320;

  const documentStub = {
    // 标记"这是我们的桩，不是真实 DOM"：`installStubDom` 靠它判断
    // 全局里已经存在的 document 该不该被接管（别人留下的桩要接管，真实 DOM 不动）
    __stubDom: true,
    activeElement: null as unknown,
    createElement: (tag: string): StubNode => {
      const node = makeStubNode(tag);
      if (tag === 'canvas') {
        const record: FakeCanvasRecord = {
          texts: [],
          fillRects: 0,
          strokeRects: 0,
          dashCalls: 0,
          transforms: 0,
        };
        const ctx = {
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          font: '',
          textAlign: 'left',
          textBaseline: 'top',
          setTransform: (): void => {
            record.transforms += 1;
          },
          clearRect: (): void => undefined,
          fillRect: (): void => {
            record.fillRects += 1;
          },
          strokeRect: (): void => {
            record.strokeRects += 1;
          },
          setLineDash: (): void => {
            record.dashCalls += 1;
          },
          fillText: (text: string): void => {
            record.texts.push(text);
          },
        };
        node.clientWidth = 120;
        (node as unknown as Record<string, unknown>).getContext = (): unknown => ctx;
        canvases.push({ node, record });
      }
      return node;
    },
    querySelector: (): null => null,
  };

  const walk = (predicate: (node: StubNode) => boolean): StubNode[] => {
    const found: StubNode[] = [];
    const visit = (node: StubNode): void => {
      if (predicate(node)) found.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    return found;
  };

  return {
    document: documentStub as unknown as Document,
    root,
    canvases,
    walk,
    byText: (text: string) => walk((node) => node.textContent === text)[0],
  };
}

/**
 * 装/卸全局 DOM：装上去之前先记下原描述符，卸的时候原样还回去，不给别的断言留污染。
 *
 * ── 为什么要"接管"而不是"已经有就跳过" ──
 * 第一版是 `if (已经存在 document) return null;`，而调用方把这种情况判成**失败**。
 * 单独跑这个文件时没问题，但被 `npm run verify` 收进去之后它红了 ——
 * 因为**另一个检查模块的 DOM 桩没卸干净**，`document` 已经躺在全局里了。
 * 一条断言因为别人留下的状态而失败，它自己一行代码都没错。
 *
 * 这种"断言之间互相污染"的病不能靠删掉那条断言来治。正确做法是：
 * 接管现有的 document（无论真假），卸的时候把原描述符原样还回去；
 * 只有当现存的 document 看起来是**真实浏览器 DOM** 时才不动它 —— 那种情况下
 * 该测的本来就是真实 DOM，而不是我们的桩。
 */
function installStubDom(): { dom: StubDom; restore: () => void } | null {
  const existing = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const existingValue = existing?.value as { createElement?: unknown; __stubDom?: unknown } | undefined;
  const looksReal =
    existingValue !== undefined &&
    typeof existingValue.createElement === 'function' &&
    existingValue.__stubDom === undefined;
  if (looksReal) return null;

  const dom = makeStubDom();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document });
  return {
    dom,
    restore: () => {
      if (existing) Object.defineProperty(globalThis, 'document', existing);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

export function runPreviewChecks(check: CheckFn): void {
  // ---------------------------------------------------------------- 1. 8 个模板
  const previews = new Map<string, PreviewData>();
  for (const template of MAP_TEMPLATES) {
    let data: PreviewData | null = null;
    let error = '';
    try {
      data = buildPreview({ templateId: template.id, seed: template.params.seed });
    } catch (caught) {
      error = messageOf(caught);
    }
    if (data) previews.set(template.id, data);
    check(
      `模板「${template.name}」能构建预览且高度场长度 = resolution²`,
      data !== null && data.heights.length === data.resolution * data.resolution,
      data
        ? `${data.resolution}×${data.resolution}=${data.heights.length} 个采样格｜地表 y ${data.minHeight}~${data.maxHeight}｜地块 ${data.plots.length}｜自然物点 ${data.natureMarks.length}`
        : `构建失败：${error}`,
    );
  }
  check('8 个模板都拿到了预览数据', previews.size === MAP_TEMPLATES.length, `实际 ${previews.size} / ${MAP_TEMPLATES.length}`);

  // ---------------------------------------------------------------- 2. 种子可复现（最重要的一条）
  const repeatA = buildPreview({ templateId: 'deep_forest', seed: 4242 });
  const repeatB = buildPreview({ templateId: 'deep_forest', seed: 4242 });
  check(
    '同一模板 + 同一种子 → 高度场逐字节相同（种子可复现）',
    typedArrayEquals(repeatA.heights, repeatB.heights) &&
      typedArrayEquals(repeatA.surfaceIds, repeatB.surfaceIds) &&
      repeatA.minHeight === repeatB.minHeight &&
      repeatA.maxHeight === repeatB.maxHeight &&
      repeatA.waterLevel === repeatB.waterLevel,
    `不同字节 ${countByteDifferences(repeatA.heights, repeatB.heights)}｜地表 id 不同字节 ${countByteDifferences(repeatA.surfaceIds, repeatB.surfaceIds)}`,
  );
  check(
    '同一模板 + 同一种子 → 地块与自然物点也逐项相同（规划与撒点同样是种子化的）',
    JSON.stringify(repeatA.plots) === JSON.stringify(repeatB.plots) &&
      JSON.stringify(repeatA.natureMarks) === JSON.stringify(repeatB.natureMarks),
    `地块 ${repeatA.plots.length} 块｜自然物点 ${repeatA.natureMarks.length} 个`,
  );

  const otherSeed = buildPreview({ templateId: 'deep_forest', seed: 4243 });
  check(
    '换一个种子 → 高度场至少有一格不同',
    !typedArrayEquals(repeatA.heights, otherSeed.heights),
    `不同的格数 ${countByteDifferences(repeatA.heights, otherSeed.heights)} / ${repeatA.heights.length}`,
  );

  // ---------------------------------------------------------------- 3. 分辨率与数值范围
  const tooSmall = buildPreview({ templateId: 'plain_village', seed: 1001, resolution: 4 });
  const tooBig = buildPreview({ templateId: 'plain_village', seed: 1001, resolution: 5000 });
  const byDefault = buildPreview({ templateId: 'plain_village', seed: 1001 });
  check(
    `resolution 低于下限被夹到 ${RESOLUTION_LIMITS.min}`,
    tooSmall.resolution === RESOLUTION_LIMITS.min,
    `传 4 → ${tooSmall.resolution}`,
  );
  check(
    `resolution 高于上限被夹到 ${RESOLUTION_LIMITS.max}`,
    tooBig.resolution === RESOLUTION_LIMITS.max,
    `传 5000 → ${tooBig.resolution}`,
  );
  check(
    `不传 resolution 时用默认值 ${RESOLUTION_LIMITS.default}`,
    byDefault.resolution === RESOLUTION_LIMITS.default,
    `实际 ${byDefault.resolution}`,
  );

  let outsideRange = 0;
  let notFinite = 0;
  for (const data of previews.values()) {
    for (let i = 0; i < data.heights.length; i += 1) {
      const value = data.heights[i]!;
      if (!Number.isFinite(value)) notFinite += 1;
      else if (value < 0 || value > 1) outsideRange += 1;
    }
  }
  check(
    '高度场归一化后全部落在 0~1，且没有 NaN / Infinity',
    outsideRange === 0 && notFinite === 0,
    `越界 ${outsideRange} 格｜非有限数 ${notFinite} 格`,
  );
  check(
    '每个模板的 minHeight ≤ maxHeight 且水位要么是 null 要么在 0~1',
    [...previews.values()].every(
      (data) =>
        data.minHeight <= data.maxHeight &&
        (data.waterLevel === null || (data.waterLevel >= 0 && data.waterLevel <= 1)),
    ),
  );

  // ---------------------------------------------------------------- 4. 模板之间的差异（用实测值比，不写死数字）
  const plain = previews.get('plain_village');
  const mountain = previews.get('high_mountain');
  const island = previews.get('archipelago');
  const desert = previews.get('desert_dunes');
  const plainRelief = plain ? plain.maxHeight - plain.minHeight : 0;
  const mountainRelief = mountain ? mountain.maxHeight - mountain.minHeight : 0;
  check(
    '高山峡谷的高度极差 ≥ 平原村庄（实测值比较，没有写死任何数字）',
    plain !== undefined && mountain !== undefined && mountainRelief >= plainRelief,
    `高山极差 ${mountainRelief} 米（y ${mountain?.minHeight}~${mountain?.maxHeight}）｜平原极差 ${plainRelief} 米（y ${plain?.minHeight}~${plain?.maxHeight}）`,
  );
  check(
    '水比例高的模板水位（归一化）也更高（实测：群岛 > 沙漠）',
    island?.waterLevel != null && desert?.waterLevel != null && island.waterLevel > desert.waterLevel,
    `群岛 ${island?.waterLevel?.toFixed(3) ?? '不可用'} vs 沙漠 ${desert?.waterLevel?.toFixed(3) ?? '不可用'}`,
  );
  check(
    '预览出来的地形确实有起伏（不是被夹成平地）',
    plainRelief > 0 && mountainRelief > 0,
    `平原极差 ${plainRelief} 米｜高山极差 ${mountainRelief} 米`,
  );

  // ---------------------------------------------------------------- 5. 地块与自然物点
  const allPlotsInRange = [...previews.values()].every((data) =>
    data.plots.every(
      (plot) =>
        plot.x0 >= 0 &&
        plot.z0 >= 0 &&
        plot.x1 <= data.resolution &&
        plot.z1 <= data.resolution &&
        plot.x0 < plot.x1 &&
        plot.z0 < plot.z1,
    ),
  );
  const totalPlots = [...previews.values()].reduce((sum, data) => sum + data.plots.length, 0);
  check('所有地块矩形都落在预览网格内且 x0<x1、z0<z1', allPlotsInRange, `8 个模板共 ${totalPlots} 块地`);

  const allMarksInRange = [...previews.values()].every((data) =>
    data.natureMarks.every(
      (mark) =>
        mark.x >= 0 &&
        mark.x <= data.resolution &&
        mark.z >= 0 &&
        mark.z <= data.resolution &&
        mark.kind.length > 0 &&
        hasChinese(mark.kind),
    ),
  );
  const totalMarks = [...previews.values()].reduce((sum, data) => sum + data.natureMarks.length, 0);
  check('自然物点的类别名非空且是中文，坐标在预览网格内', allMarksInRange, `8 个模板共 ${totalMarks} 个点`);

  // 水下格子的地表体素应当真的是水（地表颜色是从真实网格里读的，这一条验证读取没错位）
  const waterVoxel = getVoxelId('water');
  let underwaterChecked = 0;
  let underwaterWater = 0;
  for (const data of previews.values()) {
    if (data.waterLevel === null) continue;
    for (let i = 0; i < data.heights.length; i += 1) {
      if (data.heights[i]! >= data.waterLevel) continue;
      underwaterChecked += 1;
      if (data.surfaceIds[i] === waterVoxel) underwaterWater += 1;
    }
  }
  check(
    '水位以下的采样格，地表体素读到的确实是「水」',
    underwaterChecked === 0 || underwaterWater === underwaterChecked,
    `水下格 ${underwaterChecked} 个，其中读到水 ${underwaterWater} 个`,
  );

  // ---------------------------------------------------------------- 6. limitations 与 describePreview
  const allLimitations = [...previews.values()].map((data) => data.limitations);
  check(
    '每个模板的 limitations 至少 3 条',
    allLimitations.every((list) => list.length >= 3),
    `最少 ${Math.min(...allLimitations.map((list) => list.length))} 条`,
  );
  check(
    'limitations 每一条都是中文',
    allLimitations.every((list) => list.every((text) => hasChinese(text))),
  );
  const joined = allLimitations.map((list) => list.join('\n')).join('\n');
  check(
    'limitations 写清了「近似预览」「洞穴/悬垂的预览是错的」「不跑物理」这三件事',
    joined.includes('近似预览') && joined.includes('洞穴') && joined.includes('物理'),
  );
  check(
    'limitations 里没有出现 undefined / NaN / null 这类漏出来的占位文本',
    !/undefined|NaN|\bnull\b/.test(joined),
  );

  const plainData = previews.get('plain_village');
  const description = plainData ? describePreview(plainData) : '';
  check(
    'describePreview 返回非空中文，且含模板名与种子',
    description.length > 0 &&
      hasChinese(description) &&
      description.includes('平原村庄') &&
      plainData !== undefined &&
      description.includes(String(plainData.seed)),
    description.slice(0, 120),
  );

  // ---------------------------------------------------------------- 7. 画布（Node 下安全的那些分支）
  const nullContextCanvas = makeFakeCanvas(false);
  const nullContextResult = noThrow(() =>
    renderPreviewCanvas(nullContextCanvas.canvas, repeatA, { showPlots: true, showNature: true, showWater: true }),
  );
  check('getContext() 返回 null 时 renderPreviewCanvas 安全返回（不抛异常）', nullContextResult.ok, nullContextResult.error);

  const brokenCanvas = noThrow(() =>
    renderPreviewCanvas({} as unknown as HTMLCanvasElement, repeatA),
  );
  check('画布对象残缺（连 getContext 都没有）时也不抛异常', brokenCanvas.ok, brokenCanvas.error);

  const recorder = makeFakeCanvas(true, 96);
  const drawResult = noThrow(() => renderPreviewCanvas(recorder.canvas, repeatA));
  check(
    '有 ctx 时能画完（不抛异常）',
    drawResult.ok,
    drawResult.ok ? `fillRect ${recorder.record.fillRects} 次｜strokeRect ${recorder.record.strokeRects} 次` : drawResult.error,
  );
  check(
    '画布右下角写出了「近似预览」标注',
    recorder.record.texts.includes('近似预览'),
    `画布上的文字：${recorder.record.texts.join(' / ') || '（一个字都没写）'}`,
  );
  check(
    '画布确实铺满了高度场（fillRect 次数 ≥ 采样格数）',
    recorder.record.fillRects >= repeatA.resolution * repeatA.resolution,
    `fillRect ${recorder.record.fillRects} 次 / 采样格 ${repeatA.resolution * repeatA.resolution} 个`,
  );
  check(
    '用 devicePixelRatio 缩放过画布（setTransform 被调用）',
    recorder.record.transforms >= 1,
    `setTransform ${recorder.record.transforms} 次，canvas.width=${recorder.canvas.width}`,
  );

  const noPlots = makeFakeCanvas(true, 96);
  renderPreviewCanvas(noPlots.canvas, repeatA, { showPlots: false, showNature: false, showWater: false });
  check(
    'showPlots=false 时不再画地块边框（可选图层真的能关）',
    noPlots.record.strokeRects === 0 && noPlots.record.texts.includes('近似预览'),
    `strokeRect ${noPlots.record.strokeRects} 次`,
  );

  // ---------------------------------------------------------------- 8. 越界参数的处理方式：夹回（不抛错）
  //
  // 选择「夹回」而不是「抛错」的理由：`buildGenerationParams()` 本来就把越界值夹回范围
  // （面板滑杆在范围内，但存档 / URL 参数 / 旧会话记录都可能越界），
  // 预览如果在这里抛错，就会因为一条陈旧的 sessionStorage 记录而让玩家打不开面板 ——
  // 那种「宁可炸掉也不给个合理结果」的选择对这个功能没有好处。
  // 所以这里断言的是「夹回」，并且用「超上限的结果 == 直接传上限的结果」来验证。
  const overMax = buildPreview({
    templateId: 'plain_village',
    seed: 1001,
    overrides: { heightScale: TEMPLATE_PARAM_LIMITS.heightScale.max + 50 },
  });
  const atMax = buildPreview({
    templateId: 'plain_village',
    seed: 1001,
    overrides: { heightScale: TEMPLATE_PARAM_LIMITS.heightScale.max },
  });
  check(
    '越界参数被夹回范围内（超上限的结果与直接传上限逐字节相同，而不是抛错）',
    typedArrayEquals(overMax.heights, atMax.heights),
    `超上限极差 ${overMax.maxHeight - overMax.minHeight} 米｜上限极差 ${atMax.maxHeight - atMax.minHeight} 米`,
  );
  const unknownKey = buildPreview({ templateId: 'plain_village', seed: 1001, overrides: { 不存在的参数: 9 } });
  check(
    '不认识的参数键被忽略（不会因为拼错一个键就让整张图变样）',
    typedArrayEquals(unknownKey.heights, byDefault.heights),
    `极差 ${unknownKey.maxHeight - unknownKey.minHeight} 米`,
  );

  // ---------------------------------------------------------------- 9. 预览耗时（best-of-10 的最小值）
  //
  // 为什么取最小值而不是平均值：这份断言是在**并发**环境里跑的（CI、别人的构建同时在吃 CPU），
  // 平均值会被偶发的抢调度整个抬高，于是断言变成随机失败 —— 而随机失败的断言很快就会被
  // 后人注释掉，等于没有。最小值反映的是「这段代码本身最快能跑多快」，与负载无关，才有意义。
  // ⚠ 不要把它改成平均值（这一段就是为了防止那种「顺手优化」）。
  //
  // 预热一次：第一次调用要付 JIT 编译与模块懒初始化的钱，那不是「预览的耗时」。
  buildPreview({ templateId: 'city_block', seed: 8008 });
  const perfRequest: PreviewRequest = { templateId: 'city_block', seed: 8008 };
  const timings: number[] = [];
  for (let i = 0; i < 10; i += 1) timings.push(timePreview({ ...perfRequest, seed: 8008 + i }));
  const bestMs = Math.min(...timings);
  check(
    '96×96 分辨率下单次 buildPreview < 100 ms（best-of-10 最小值）',
    bestMs < 100,
    `最快 ${bestMs.toFixed(1)} ms｜10 次：${timings.map((ms) => ms.toFixed(1)).join(' / ')}`,
  );

  // ---------------------------------------------------------------- 10. 模板面板（无 DOM 模式）
  const calls = { generate: 0, preview: 0 };
  const rollbackReasons: string[] = [];
  const lastRequest: { templateId: string; seed: number } = { templateId: '', seed: 0 };
  const handlers = {
    onGenerate: (request: { templateId: string; seed: number; overrides: Record<string, number> }): void => {
      calls.generate += 1;
      lastRequest.templateId = request.templateId;
      lastRequest.seed = request.seed;
    },
    onPreview: (): void => {
      calls.preview += 1;
    },
    onRollback: (reason: string): void => {
      rollbackReasons.push(reason);
    },
  };

  let uiCreated = false;
  let uiError = '';
  let uiDisposedRefreshSafe = false;
  let problemsMatchValidator = false;
  let illegalGenerateBlocked = false;
  let legalGenerateSubmitted = false;
  let illegalValueKeptRaw = false;
  let rollbackRestored: string | null = null;
  let rollbackReasonText = '';
  let noRecordDegraded = false;
  try {
    const ui = new MapTemplateUI(null, handlers);
    uiCreated = true;
    // Node 下没有 sessionStorage（或存储为空）：一开始必须如实报告「没有可回滚的记录」
    noRecordDegraded = ui.hasRollbackRecord === false;

    ui.setSelected('high_mountain');
    ui.setSeed(2002);
    const illegal = TEMPLATE_PARAM_LIMITS.waterRatio.max + 5;
    ui.setParam('waterRatio', illegal);
    const reported = [...ui.getProblems()];
    const expected = validateTemplateParams(ui.getParams());
    problemsMatchValidator =
      reported.length > 0 &&
      reported.length === expected.length &&
      reported.every((text, index) => text === expected[index]);
    // 「标红 + 禁止生成」里的后半句：非法值下提交必须被拒，且不能调 handler
    illegalGenerateBlocked = ui.requestGenerate() === false && calls.generate === 0;
    illegalValueKeptRaw = (ui.getParams() as unknown as Record<string, number>).waterRatio === illegal;
    ui.setParam('waterRatio', 0.5);
    legalGenerateSubmitted = ui.requestGenerate() === true && calls.generate === 1;

    // 补充 5：换个模板 + 换个种子，再回滚 —— 必须回到上一次「生成」时的模板与种子，并重新生成
    ui.setSelected('snow_field');
    ui.setSeed(999);
    rollbackRestored = ui.requestRollback() ? `${lastRequest.templateId}#${lastRequest.seed}` : null;
    rollbackReasonText = rollbackReasons.join('｜');

    ui.dispose();
    const afterDispose = noThrow(() => ui.refresh());
    uiDisposedRefreshSafe = afterDispose.ok;
  } catch (caught) {
    uiError = messageOf(caught);
  }

  check('new MapTemplateUI(null, handlers) 不抛异常（Node 下走无 DOM 模式）', uiCreated, uiError);
  check('dispose() 之后调用 refresh() 不抛异常（安全空操作）', uiDisposedRefreshSafe, uiError);
  check(
    '非法参数时 UI 报告的校验结果与 validateTemplateParams(ui.getParams()) 完全一致',
    problemsMatchValidator,
    problemsMatchValidator ? '逐条相同' : '不一致或空值',
  );
  check(
    '非法参数被禁止生成（requestGenerate 返回 false 且没有调 onGenerate），且原值没有被悄悄夹回',
    illegalGenerateBlocked && illegalValueKeptRaw,
    `生成调用次数 ${calls.generate}`,
  );
  check(
    '参数合法时 requestGenerate 能提交，并把模板与种子原样传给 handler',
    legalGenerateSubmitted && lastRequest.templateId === 'high_mountain' && lastRequest.seed === 2002,
    `模板 ${lastRequest.templateId}｜种子 ${lastRequest.seed}｜提交 ${calls.generate} 次`,
  );
  check(
    '回滚（补充 5）恢复上一次生成时的模板与种子，并重新提交生成',
    rollbackRestored === 'high_mountain#2002',
    `回滚后提交的是 ${rollbackRestored ?? '（没有回滚成功）'}，共 ${calls.generate} 次生成`,
  );
  check(
    '回滚原因里写清了「只回滚参数与种子、不回滚体素」',
    rollbackReasonText.includes('不回滚体素') && hasChinese(rollbackReasonText),
    rollbackReasonText,
  );
  check('没有 sessionStorage 时降级为「没有可回滚的记录」（不抛异常）', noRecordDegraded);
  check(
    'requestPreview 走的是同一条路径（合法参数时能提交）',
    new MapTemplateUI(null, handlers).requestPreview() === true && calls.preview === 1,
    `预览调用 ${calls.preview} 次`,
  );

  // ---------------------------------------------------------------- 11. 存储坏掉时的降级路径
  //
  // 隐私模式 / 配额满在测试里没法真的制造，所以注入一个「读写都抛」的 sessionStorage ——
  // 那正是这两种故障在代码里的形态（getItem/setItem 抛异常），比任何伪造的成功路径都接近真实。
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let storageSwapOk = false;
  let badStorageSafe = false;
  let badStorageRollbackSafe = false;
  let badStorageError = '';
  try {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (): string => {
          throw new Error('模拟：sessionStorage 被禁用');
        },
        setItem: (): void => {
          throw new Error('模拟：sessionStorage 配额满');
        },
      },
    });
    storageSwapOk = true;
    const ui = new MapTemplateUI(null, handlers);
    badStorageSafe = ui.hasRollbackRecord === false;
    badStorageRollbackSafe = ui.requestGenerate() === true;
  } catch (caught) {
    badStorageError = messageOf(caught);
  } finally {
    // 无论断言结果如何都要把全局恢复回去，否则后面的断言（或别的 check 文件）会踩到这个假存储
    if (storageSwapOk) {
      if (originalDescriptor) Object.defineProperty(globalThis, 'sessionStorage', originalDescriptor);
      else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  }
  check(
    'sessionStorage 读失败（被禁用）时降级为「没有可回滚的记录」，不抛异常',
    storageSwapOk && badStorageSafe,
    storageSwapOk ? '读失败后 hasRollbackRecord === false' : `无法注入假存储：${badStorageError}`,
  );
  check(
    'sessionStorage 写失败（配额满）时生成照常提交（回滚记录退化成只在本次会话内有效）',
    storageSwapOk && badStorageRollbackSafe,
    storageSwapOk ? '写入抛异常但 requestGenerate 仍然返回 true' : `无法注入假存储：${badStorageError}`,
  );
  check(
    '假存储已经被还原（不给别的断言留下全局污染）',
    Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') === originalDescriptor ||
      (!storageSwapOk && originalDescriptor === undefined),
    'sessionStorage 描述符与注入前一致',
  );

  // ---------------------------------------------------------------- 12. 模板数据的一致性
  check(
    '面板与预览用的是同一份模板表（8 套，id 都能被 getMapTemplate 找到）',
    MAP_TEMPLATES.length === 8 && MAP_TEMPLATES.every((template) => getMapTemplate(template.id)?.id === template.id),
    `共 ${MAP_TEMPLATES.length} 套`,
  );

  // ---------------------------------------------------------------- 13. 面板的 DOM 分支（极简 DOM 桩）
  runDomBranchChecks(check, handlers, calls, lastRequest);
}

/**
 * DOM 分支：卡片、滑杆、按钮禁用、缩略图懒加载。
 *
 * 用一个手搓的极简 DOM 桩（不是 jsdom —— 本轮不许加依赖）覆盖那条分支。
 * 懒加载分两段测，因为这两种环境的行为本来就不同：
 * A. 有 IntersectionObserver（浏览器）→ **一张都不该提前算**；选中它、或它进入视口才算；
 * B. 没有 IntersectionObserver（老浏览器 / Node）→ 降级成直接算全部 8 张。
 */
function runDomBranchChecks(
  check: CheckFn,
  handlers: MapTemplateUIHandlers,
  calls: { generate: number; preview: number },
  lastRequest: { templateId: string; seed: number },
): void {
  // 先探一下环境：正常情况下 Node 里没有 document，桩能装上
  const probe = installStubDom();
  if (!probe) {
    check('DOM 桩可用（本环境里没有 document）', false, '本环境已经有 document，DOM 分支断言需要按真实环境调整');
    return;
  }
  probe.restore();

  /** 模拟「卡片进入视口」用的 IntersectionObserver 桩 */
  class StubObserver {
    static instances: StubObserver[] = [];
    readonly observed: StubNode[] = [];
    private readonly emit: (entries: { isIntersecting: boolean; target: unknown }[]) => void;
    constructor(callback: (entries: { isIntersecting: boolean; target: unknown }[]) => void) {
      this.emit = callback;
      StubObserver.instances.push(this);
    }
    observe(target: StubNode): void {
      this.observed.push(target);
    }
    disconnect(): void {
      this.observed.length = 0;
    }
    enter(target: StubNode): void {
      this.emit([{ isIntersecting: true, target }]);
    }
  }

  // ---------------- A 段：有 IntersectionObserver（浏览器）→ 懒加载
  let cardCount = 0;
  let lazyNoneDrawn = false;
  let selectedOnlyDrawn = false;
  let visibleDrawn = false;
  let phaseAError = '';
  {
    StubObserver.instances = [];
    const stub = installStubDom();
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: StubObserver });
    try {
      const dom = stub!.dom;
      const ui = new MapTemplateUI(dom.root as unknown as HTMLElement, handlers);
      cardCount = dom.walk((node) => node.dataset.templateId !== undefined).length;
      // 构造阶段一张都不该算：8 个模板一次算完 ≈ 200 ms 的主线程占用，那正是要避免的
      lazyNoneDrawn = dom.canvases.every((canvas) => canvas.record.fillRects === 0);
      // 选中一张：只算它自己
      ui.setSelected('city_block');
      selectedOnlyDrawn = dom.canvases.filter((canvas) => canvas.record.fillRects > 0).length === 1;
      // 再让第一张卡片进入视口：只多算那一张
      const observer = StubObserver.instances[0];
      const firstCard = observer?.observed[0];
      if (observer && firstCard) observer.enter(firstCard);
      visibleDrawn = dom.canvases.filter((canvas) => canvas.record.fillRects > 0).length === 2;
      ui.dispose();
    } catch (caught) {
      phaseAError = messageOf(caught);
    } finally {
      delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
      stub!.restore();
    }
  }
  check('DOM 模式下建出了 8 张模板卡片', cardCount === MAP_TEMPLATES.length, `实际 ${cardCount} 张`);
  check(
    '缩略图懒加载：有 IntersectionObserver 时，构造面板阶段一张都没算',
    lazyNoneDrawn,
    phaseAError,
  );
  check('选中某张卡片时只算那一张缩略图', selectedOnlyDrawn, phaseAError);
  check('卡片进入视口后才算它的缩略图（滚动时按需计算）', visibleDrawn, phaseAError);

  // ---------------- B 段：没有 IntersectionObserver → 降级为直接算全部
  let fallbackAllDrawn = false;
  let sliderReachedState = false;
  let busyDisabled = false;
  let busyLabelShown = false;
  let illegalDisabled = false;
  let illegalMarkedRed = false;
  let clickGenerateSubmitted = false;
  let domDisposeSafe = false;
  let phaseBError = '';
  {
    const stub = installStubDom();
    try {
      const dom = stub!.dom;
      const ui = new MapTemplateUI(dom.root as unknown as HTMLElement, handlers);
      fallbackAllDrawn =
        dom.canvases.length === MAP_TEMPLATES.length &&
        dom.canvases.every((canvas) => canvas.record.fillRects > 0);

      // 滑杆：通过界面上的 input 事件改值，UI 状态要真的跟着变
      const ranges = dom.walk((node) => node.tagName === 'input' && node.type === 'range');
      const waterRange = ranges[1];
      if (waterRange) {
        waterRange.value = '0.42';
        waterRange.dispatch('input');
        sliderReachedState = ui.getParams().waterRatio === 0.42;
      }

      // 忙状态：生成与预览都必须禁用，并显示「正在做什么」
      ui.setBusy(true, '正在生成地图…');
      busyDisabled = dom.byText('生成')?.disabled === true && dom.byText('预览')?.disabled === true;
      busyLabelShown = dom.walk((node) => node.textContent.includes('正在生成地图…')).length > 0;
      ui.setBusy(false);

      // 非法参数：界面上标红 + 生成按钮禁用
      const generateBefore = calls.generate;
      ui.setParam('treeDensity', TEMPLATE_PARAM_LIMITS.treeDensity.max + 1);
      illegalMarkedRed = dom.walk((node) => node.style.color === '#ff8a7a').length > 0;
      illegalDisabled = dom.byText('生成')?.disabled === true && calls.generate === generateBefore;

      // 修好参数 → 点界面上的「生成」按钮（走真实的 click 事件）
      ui.setParam('treeDensity', 1);
      dom.byText('生成')?.dispatch('click');
      clickGenerateSubmitted = calls.generate === generateBefore + 1 && lastRequest.templateId === 'plain_village';

      ui.dispose();
      domDisposeSafe = noThrow(() => ui.refresh()).ok;
    } catch (caught) {
      phaseBError = messageOf(caught);
    } finally {
      stub!.restore();
    }
  }
  check(
    '没有 IntersectionObserver 时降级为直接算全部缩略图（宁可慢，不能空着）',
    fallbackAllDrawn,
    phaseBError,
  );
  check('滑杆通过界面事件改值后，UI 状态真的跟着变了', sliderReachedState, phaseBError);
  check('setBusy(true) 时「生成」与「预览」都禁用，并显示正在做什么', busyDisabled && busyLabelShown, phaseBError);
  check('参数非法时「生成」按钮被禁用，并且界面上有标红提示', illegalDisabled && illegalMarkedRed, phaseBError);
  check('点击界面上的「生成」按钮会走到 onGenerate（真实 click 事件路径）', clickGenerateSubmitted, phaseBError);
  check('DOM 模式下 dispose() 之后 refresh() 也不抛异常', domDisposeSafe, phaseBError);
}
