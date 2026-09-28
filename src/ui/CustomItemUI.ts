/**
 * 自定义物品编辑器（M4 补充 2）。
 *
 * ────────────────────────────────────────────────────────────
 * 这个面板与 `data/customItems.ts` 的分工（写死在这里，免得以后被当成疏漏）
 * ────────────────────────────────────────────────────────────
 * 校验、规范化、id 生成、读写 localStorage、导入导出**全部在 `data/customItems.ts` 里**。
 * 这里只做三件事：把草稿画出来、把玩家的操作写回草稿、把 `validateCustomItem()` 的结果念出来。
 *
 * 为什么必须这样分：自定义物品是**玩家输入**，而它的规则会跟着物理一起变
 * （零件数上限、NaN 检查、单边尺寸上限、底面贴地……）。UI 里再抄一份"尺寸必须大于 0"，
 * 就一定会出现"界面说能存、点保存却被拒"或者反过来的情况 —— 玩家根本没法自己查，
 * 我们也没法在没有浏览器的情况下复现。所以这里的**问题列表只有一个来源**：
 * `validateCustomItem()` 说 ok，「保存」按钮才可点。
 *
 * ────────────────────────────────────────────────────────────
 * 预览为什么必须能降级，以及它未经实测这件事
 * ────────────────────────────────────────────────────────────
 * 预览是用 Three.js 现搭的一个小场景（零件 + 原点网格）。但 `WebGLRenderer` 在拿不到
 * WebGL 上下文时**会抛异常**（Node、无 GPU 的容器、浏览器禁用 WebGL 都会）。
 * 本项目没有浏览器可用 —— 也就是说**这条渲染路径从来没有被真正跑过**。
 * 宁可它在没有 WebGL 的环境里诚实地退回文字摘要
 * （`圆柱 @ (0, 1.5, 0) 0.4×3×0.4`），也不能让整个面板在这种情况下挂掉。
 *
 * 因此这里的顺序是：**先自己取上下文，拿不到就根本不建渲染器**。
 * 不用"建了再 catch"：构造失败的 WebGLRenderer 已经往 canvas 上挂过监听、分配过资源，
 * 留下的是半个实例，比"根本没建"更难查。
 *
 * ────────────────────────────────────────────────────────────
 * 玩家看得见的诚实标注（做不到的事直接写在面板上）
 * ────────────────────────────────────────────────────────────
 * 不能上传模型文件、不能自定义碰撞体形状、本轮不开放零件旋转、
 * 预览是固定视角不能拖动、删除不会动物世界里已经放好的那些 ——
 * 这些全部以文字形式写在面板里，而不是藏在注释里让玩家白试。
 */

import {
  AmbientLight,
  AxesHelper,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import type { BuildingDef, BuildingPart, BuildingPartShape } from '../building/types';
import { BUILDING_CATEGORIES } from '../data/buildingCategories';
import {
  CUSTOM_ITEM_LIMIT,
  CUSTOM_ITEM_MAX_PARTS,
  CUSTOM_SHAPES,
  exportCustomItems,
  importCustomItems,
  loadCustomItems,
  saveCustomItems,
  validateCustomItem,
  type CustomItemDraft,
  type CustomItemValidation,
} from '../data/customItems';

export interface CustomItemUIHandlers {
  /** 存好并注册进物品库之后回调（Engine 用它刷新物品面板 / 选中新物品） */
  onCreated(def: BuildingDef): void;
  /** 删除一个自定义物品（Engine 用它处理"世界里已经放了这种物品"的问题） */
  onDeleted(defId: string): void;
  onError?(message: string): void;
}

/** 一次操作的结果。中文说明**成功与失败都要有** —— 界面上原样显示，不做二次加工 */
export interface CustomItemOpResult {
  ok: boolean;
  message: string;
  /** 本次操作影响到的物品个数（导入 / 删除用；不涉及就是 0） */
  count: number;
}

/** 预览画布的逻辑尺寸（拿不到真实 CSS 尺寸时用，例如离屏 / 测试环境） */
const PREVIEW_WIDTH = 260;
const PREVIEW_HEIGHT = 190;

/** 形状的中文名。键与 `CUSTOM_SHAPES` 一一对应（那张表才是唯一来源，这里只是显示名） */
const SHAPE_LABELS: Record<BuildingPartShape, string> = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球',
  cone: '圆锥',
};

/** 新建零件的默认参数：1 米方块，y=0.5 让底面正好贴住 y=0（原点在底面中心） */
const NEW_PART: BuildingPart = { shape: 'box', position: [0, 0.5, 0], size: [1, 1, 1], color: 0xaaaaaa };

const ORIGIN_NOTE = '原点在底面中心：网格就是地面（y=0），保存时整个模型会自动抬到最低点贴住 y=0。';

const LIMITATIONS_NOTE =
  '做不到的（如实写在这里，免得白试）：不能上传模型文件（纯前端，也没有模型解析器）；' +
  '不能自定义碰撞体形状（碰撞体按这些零件拼出来，与内置物品一致）；' +
  '本轮不开放零件旋转角度（只能改形状 / 位置 / 尺寸 / 颜色）；' +
  '预览是固定视角、不能拖动旋转。';

const DELETE_NOTE = '删除只是把它从物品库里拿掉 —— 世界里已经放好的那些不会被删掉，要不要一起处理由引擎决定。';

/** 主色 / 零件颜色的输入框在合法值时给玩家的回话（非法值一律拒绝，见 parseColorHex） */
const COLOR_HINT = '颜色用取色器选（浏览器只会给出 #rrggbb）';

/**
 * 元信息的输入框 → 草稿字段的映射键。
 * 用 data 属性做委托，是因为重画时节点会被换掉，逐个挂监听一定会漏摘。
 */
type MetaField =
  | 'name'
  | 'category'
  | 'subcategory'
  | 'icon'
  | 'color'
  | 'density'
  | 'friction'
  | 'restitution'
  | 'isStatic'
  | 'stackable';

/** 零件输入框的两类数字字段 */
type PartNumberField = 'position' | 'size';

/** 预览当前是"真的画出来了"还是"退回了文字摘要" */
type PreviewMode = 'webgl' | 'text';

/** 编辑器用到的节点。`container === null` 时整个是 null —— 所有渲染分支都要先看它 */
interface EditorNodes {
  root: HTMLElement;
  limitNote: HTMLElement;
  metaBox: HTMLElement;
  nameInput: HTMLInputElement;
  categorySelect: HTMLSelectElement;
  subcategoryInput: HTMLInputElement;
  iconInput: HTMLInputElement;
  colorInput: HTMLInputElement;
  densityInput: HTMLInputElement;
  frictionInput: HTMLInputElement;
  restitutionInput: HTMLInputElement;
  staticInput: HTMLInputElement;
  stackableInput: HTMLInputElement;
  shapeSelect: HTMLSelectElement;
  addButton: HTMLButtonElement;
  partsBox: HTMLElement;
  summaryBox: HTMLElement;
  problemsBox: HTMLElement;
  previewCanvas: HTMLCanvasElement | null;
  previewNote: HTMLElement;
  saveButton: HTMLButtonElement;
  saveNote: HTMLElement;
  savedBox: HTMLElement;
  exportText: HTMLTextAreaElement;
  downloadButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  pasteText: HTMLTextAreaElement;
  importButton: HTMLButtonElement;
  ioStatus: HTMLElement;
}

// ------------------------------------------------------------------ 小工具

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 数字格式化：非有限值写成「非数字」。
 * 直接 `String(NaN)` 会让界面上出现 "NaN" —— 玩家会以为是自己看错了，
 * 而它其实是"这个字段的数据坏了"，必须说出来。
 */
function fmt(value: number): string {
  if (!Number.isFinite(value)) return '非数字';
  return String(Number(value.toFixed(3)));
}

/** 形状中文名。草稿里的形状可能来自手改过的存档，查不到就如实写「未知形状」，不猜 */
function shapeLabel(shape: BuildingPartShape): string {
  return Object.prototype.hasOwnProperty.call(SHAPE_LABELS, shape) ? SHAPE_LABELS[shape] : '未知形状';
}

/** 单个零件的摘要行：`圆柱 @ (0, 1.5, 0) 0.4×3×0.4` */
function describePart(part: BuildingPart): string {
  const [x, y, z] = part.position;
  const [sx, sy, sz] = part.size;
  return `${shapeLabel(part.shape)} @ (${fmt(x)}, ${fmt(y)}, ${fmt(z)}) ${fmt(sx)}×${fmt(sy)}×${fmt(sz)}`;
}

/**
 * `#rrggbb` → 数字；不是严格的六位十六进制就返回 null。
 *
 * 为什么在这里拦一下而不是把 NaN 写进草稿：`<input type="color">` 在真实浏览器里
 * **只会**给出 `#rrggbb`，只有 DOM 被手改过才会送进别的字符串。而 NaN 颜色
 * 会一路渗到预览与缩略图（`colorToHexString` 会拼出 `#NaN`）。
 * 所以非法值**拒绝写入、保留原颜色**并如实说明；草稿里真出现了非法颜色，
 * 那也一定是别的入口写进去的，由 `validateCustomItem` 负责报「颜色不合法」。
 */
function parseColorHex(text: string): number | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(text.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return Number.isFinite(value) ? value : null;
}

/** 数字 → `#rrggbb`（取色器要的值） */
function hexOf(color: number): string {
  const safe = Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, Math.round(color))) : 0x000000;
  return `#${safe.toString(16).padStart(6, '0')}`;
}

function makeDiv(className = ''): HTMLElement {
  const el = document.createElement('div');
  if (className) el.className = className;
  return el;
}

function makeSpan(text: string, className = ''): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function makeButton(label: string, action: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  // 动作名写在 data 上：重画后仍然能被容器上的委托认出来
  button.dataset.customItemAction = action;
  return button;
}

function makeTextInput(placeholder: string, maxLength?: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  if (maxLength !== undefined) input.maxLength = maxLength;
  return input;
}

function makeNumberInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  // 刻意**不**设 min：让 0 / 负数真的进草稿，再由 validateCustomItem 报错。
  // 用输入框挡住非法值会掩盖真实问题，也正是"UI 自己判一套"的开端。
  return input;
}

function makeColorInput(color: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = hexOf(color);
  input.title = COLOR_HINT;
  return input;
}

function makeCheckbox(labelText: string, checked: boolean): { label: HTMLElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(makeSpan(` ${labelText}`));
  return { label, input };
}

/** 一行「标题 + 控件」。标题用 span 而不是 createTextNode：桩 DOM 的面更小，真 DOM 也一样 */
function makeField(title: string, control: HTMLElement): HTMLElement {
  const field = makeDiv('custom-item-field');
  field.appendChild(makeSpan(title, 'custom-item-field-title'));
  field.appendChild(control);
  return field;
}

function fillSelect(select: HTMLSelectElement, options: readonly { value: string; label: string }[]): void {
  select.textContent = '';
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
}

/** 按 parts 造一个零件网格。颜色非法时画成品红：一眼就能看出数据坏了，而不是"看起来还行" */
function makePartMesh(part: BuildingPart): Mesh {
  const [sx, sy, sz] = part.size;
  const geometry = createPartGeometry(part.shape, sx, sy, sz);
  const color = Number.isFinite(part.color) ? part.color : 0xff00ff;
  const mesh = new Mesh(geometry, new MeshLambertMaterial({ color }));
  const [x, y, z] = part.position;
  // 位置是非有限值时 three 会把整个物体从场景里丢掉（矩阵变 NaN）。
  // 用 0 兜底只是为了让预览不整体消失，真正的错误由校验器报出来。
  mesh.position.set(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0);
  mesh.rotation.set(part.rotationX ?? 0, part.rotationY ?? 0, part.rotationZ ?? 0);
  return mesh;
}

function createPartGeometry(shape: BuildingPartShape, sx: number, sy: number, sz: number): BoxGeometry | CylinderGeometry | SphereGeometry | ConeGeometry {
  // 尺寸同上：非有限值 / 非正数用 1 兜底，只为了让预览还能画出来
  const w = Number.isFinite(sx) && sx > 0 ? sx : 1;
  const h = Number.isFinite(sy) && sy > 0 ? sy : 1;
  const d = Number.isFinite(sz) && sz > 0 ? sz : 1;
  switch (shape) {
    case 'cylinder':
      // BuildingPart 的尺寸语义：圆柱 / 圆锥是 [直径, 高度, 直径]
      return new CylinderGeometry(w / 2, w / 2, h, 16);
    case 'cone':
      return new ConeGeometry(w / 2, h, 16);
    case 'sphere':
      // 球的尺寸是三个直径，所以半径 0.5 再按三轴缩放
      return new SphereGeometry(0.5, 16, 12).scale(w, h, d);
    default:
      return new BoxGeometry(w, h, d);
  }
}

/** 草稿的默认值。零件为空：`validateCustomItem` 会给出「至少要有一个几何体」 */
function defaultDraft(): CustomItemDraft {
  const fallbackCategory = BUILDING_CATEGORIES[0]?.id ?? '装饰';
  const decoration = BUILDING_CATEGORIES.some((info) => info.id === '装饰');
  return {
    name: '',
    category: decoration ? '装饰' : fallbackCategory,
    subcategory: '自定义',
    icon: '📦',
    color: 0xaaaaaa,
    density: 700,
    friction: 0.5,
    restitution: 0.2,
    isStatic: false,
    stackable: true,
    parts: [],
  };
}

export class CustomItemUI {
  private readonly handlers: CustomItemUIHandlers;
  private readonly listeners: { target: EventTarget; type: string; handler: EventListener }[] = [];
  /** 面板节点，只在 container 非空时建起来 */
  private nodes: EditorNodes | null = null;

  /** 当前草稿 —— 界面上所有输入框的唯一数据源 */
  private state: CustomItemDraft = defaultDraft();
  /** 已经保存的自定义物品（内存副本；持久化由 customItems.ts 负责） */
  private saved: BuildingDef[] = [];
  /** 上一次校验结果。缓存它，是为了"同一个改动只校验一次"，也让保存时用的是同一份结论 */
  private validation: CustomItemValidation = { ok: false, problems: [] };
  /**
   * 内存里的列表与 localStorage 不一致（这个环境写不进去）。
   * 有它才能如实说"本次打开期间有效，刷新就没了"，而不是假装存好了。
   */
  private storageOutOfSync = false;
  /** 最近一次校验的问题列表（getter 直接给断言与调用方看） */
  private problems: string[] = [];

  // ---- 预览（三条线：真的画 / 退化成文字 / 还没有容器） ----
  private previewMode: PreviewMode = 'text';
  private previewReason = '还没有初始化预览';
  private renderer: WebGLRenderer | null = null;
  private previewScene: Scene | null = null;
  private previewCamera: PerspectiveCamera | null = null;
  private previewGroup: Group | null = null;

  private disposed = false;

  constructor(container: HTMLElement | null, handlers: CustomItemUIHandlers) {
    this.handlers = handlers;

    const store = loadCustomItems();
    this.saved = [...store.items];
    if (store.lastError) this.report(store.lastError);

    if (container) {
      this.nodes = this.buildEditor(container);
      this.bindEvents(this.nodes);
      this.renderMetaInputs();
      this.renderParts();
      this.initPreview(this.nodes.previewCanvas);
    }

    this.changed();
    this.renderSaved();
  }

  // ------------------------------------------------------------------ 对外接口

  /** 把已保存的自定义物品列表画出来（重新从 localStorage 读一次，避免与别的入口不同步） */
  refresh(): void {
    if (this.disposed) return;
    const store = loadCustomItems();
    if (store.lastError) this.report(store.lastError);
    // 有内容没能写进存储时以内存为准：否则玩家刚导入的东西会被这一次刷新抹掉，
    // 而界面上明明刚说过"已导入" —— 那种自相矛盾比不刷新糟糕得多
    if (!this.storageOutOfSync) this.saved = [...store.items];
    this.renderSaved();
    this.renderDerived();
  }

  /** 当前编辑中的草稿（导出用）。给的是副本：调用方改它不该影响面板 */
  get draft(): unknown {
    return this.draftCopy();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, type, handler } of this.listeners) target.removeEventListener(type, handler);
    this.listeners.length = 0;
    this.disposePreview();
    this.nodes = null;
  }

  // ------------------------------------------------------------------ 只读状态（断言与 Engine 都能用）

  /** 校验器给出的中文问题列表（空 = 可以保存） */
  get problemList(): readonly string[] {
    return this.problems;
  }

  /** 现在能不能保存（校验通过 + 没到上限 + 面板还活着） */
  get canSave(): boolean {
    if (this.disposed) return false;
    return this.validation.ok && this.saved.length < CUSTOM_ITEM_LIMIT;
  }

  /** 不能保存的原因（中文）。能保存时是 null */
  get saveDisabledReason(): string | null {
    if (this.disposed) return '编辑器已经关闭';
    if (this.saved.length >= CUSTOM_ITEM_LIMIT) {
      return `自定义物品已经存满 ${CUSTOM_ITEM_LIMIT} 个（上限），先删掉几个才能再存`;
    }
    if (!this.validation.ok) return `还有 ${this.problems.length} 个问题要解决（见下面的清单）`;
    return null;
  }

  /** 已保存的自定义物品（内存副本） */
  get savedItems(): readonly BuildingDef[] {
    return this.saved;
  }

  /** 预览当前走的哪条路：`webgl` = 真的画了，`text` = 退回文字摘要 */
  get previewModeValue(): PreviewMode {
    return this.previewMode;
  }

  /** 预览拿不到 WebGL 时的原因（中文）。能画出来时也保留，用来说明这条路径未经实测 */
  get previewFallbackReason(): string {
    return this.previewReason;
  }

  /** 预览区当前显示的完整文字（降级时它就是"文字摘要"，断言直接读它） */
  get previewText(): string {
    return this.composePreviewText();
  }

  /** 导出当前已保存列表的 JSON（= `exportCustomItems` 的结果，原样不带加工） */
  exportText(): string {
    return exportCustomItems(this.saved);
  }

  // ------------------------------------------------------------------ 零件编辑

  /** 加一个零件。到上限就挡住，并说明原因（上限来自 CUSTOM_ITEM_MAX_PARTS，不是写死的数） */
  addPart(shape: BuildingPartShape = 'box'): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    if (this.state.parts.length >= CUSTOM_ITEM_MAX_PARTS) {
      return {
        ok: false,
        message: `最多只能有 ${CUSTOM_ITEM_MAX_PARTS} 个几何体（现在已经有 ${this.state.parts.length} 个）。要再加请先删掉一个`,
        count: 0,
      };
    }
    // 刻意不在这里检查 shape 是否在 CUSTOM_SHAPES 里：形状白名单是校验器的规则，
    // 这里再判一次就多了一份会漂移的副本。下拉框只提供 CUSTOM_SHAPES 里的形状，
    // 真被塞进别的值也会由 validateCustomItem 报「形状不合法」。
    this.state.parts.push({
      shape,
      position: [...NEW_PART.position] as [number, number, number],
      size: [...NEW_PART.size] as [number, number, number],
      color: NEW_PART.color,
    });
    this.changed();
    this.renderParts();
    return { ok: true, message: `已加第 ${this.state.parts.length} 个几何体（${shapeLabel(shape)}）`, count: 1 };
  }

  /** 删一个零件 */
  removePart(index: number): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    if (!Number.isInteger(index) || index < 0 || index >= this.state.parts.length) {
      return { ok: false, message: `没有第 ${index + 1} 个几何体可以删`, count: 0 };
    }
    this.state.parts.splice(index, 1);
    this.changed();
    this.renderParts();
    return { ok: true, message: `已删掉第 ${index + 1} 个几何体（现在剩 ${this.state.parts.length} 个）`, count: 1 };
  }

  /**
   * 改一个零件的字段（合并进现有值）。
   * 传进来的数字**不做任何清洗**：0 / 负数 / NaN 都要真的进草稿，由校验器来说它们不对。
   */
  setPart(index: number, patch: Partial<BuildingPart>): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    const part = this.state.parts[index];
    if (!part) return { ok: false, message: `没有第 ${index + 1} 个几何体`, count: 0 };
    const next: BuildingPart = { ...part };
    if (patch.shape !== undefined) next.shape = patch.shape;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.position !== undefined) {
      const source = patch.position;
      next.position = [source[0], source[1], source[2]] as [number, number, number];
    }
    if (patch.size !== undefined) {
      const source = patch.size;
      next.size = [source[0], source[1], source[2]] as [number, number, number];
    }
    if (patch.rotationX !== undefined) next.rotationX = patch.rotationX;
    if (patch.rotationY !== undefined) next.rotationY = patch.rotationY;
    if (patch.rotationZ !== undefined) next.rotationZ = patch.rotationZ;
    this.state.parts[index] = next;
    this.changed();
    // 不重建整行：正在输入的输入框被换掉会丢焦点（"打一个数字就跳出输入框"）
    return { ok: true, message: `已改第 ${index + 1} 个几何体`, count: 1 };
  }

  /** 改某个零件的一维数值（位置 / 尺寸的第 axis 个分量） */
  setPartNumber(index: number, field: PartNumberField, axis: 0 | 1 | 2, value: number): CustomItemOpResult {
    const part = this.state.parts[index];
    if (!part) return { ok: false, message: `没有第 ${index + 1} 个几何体`, count: 0 };
    const vector: [number, number, number] = field === 'position' ? [...part.position] : [...part.size];
    vector[axis] = value;
    return field === 'position' ? this.setPart(index, { position: vector }) : this.setPart(index, { size: vector });
  }

  /** 改某个零件的颜色（取色器的字符串）。非法值拒绝写入并如实说明 */
  setPartColorHex(index: number, hex: string): CustomItemOpResult {
    const parsed = parseColorHex(hex);
    if (parsed === null) {
      const message = `「${hex}」不是合法的颜色（要 #rrggbb 六位十六进制），第 ${index + 1} 个几何体的颜色保持原样`;
      this.report(message);
      return { ok: false, message, count: 0 };
    }
    return this.setPart(index, { color: parsed });
  }

  // ------------------------------------------------------------------ 元信息

  /** 改草稿的元信息（名称 / 分类 / 密度……）。key 只认已知字段，DOM 被改过也不会写进草稿 */
  setMeta(key: MetaField, value: string | number | boolean): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    switch (key) {
      case 'name':
        this.state.name = String(value);
        break;
      case 'category':
        this.state.category = String(value);
        break;
      case 'subcategory':
        this.state.subcategory = String(value);
        break;
      case 'icon':
        this.state.icon = String(value);
        break;
      case 'color': {
        const parsed = parseColorHex(String(value));
        if (parsed === null) {
          const message = `「${value}」不是合法的颜色（要 #rrggbb 六位十六进制），主色保持原样`;
          this.report(message);
          return { ok: false, message, count: 0 };
        }
        this.state.color = parsed;
        break;
      }
      case 'density':
        this.state.density = Number(value);
        break;
      case 'friction':
        this.state.friction = Number(value);
        break;
      case 'restitution':
        this.state.restitution = Number(value);
        break;
      case 'isStatic':
        this.state.isStatic = value === true;
        break;
      case 'stackable':
        this.state.stackable = value === true;
        break;
      default:
        return { ok: false, message: `未知的字段 ${String(key)}，已忽略`, count: 0 };
    }
    this.changed();
    return { ok: true, message: `已更新「${key}」`, count: 1 };
  }

  // ------------------------------------------------------------------ 保存 / 删除

  /** 保存草稿。校验没过或已满就拒绝（并且说明是哪一种） */
  save(): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    if (this.saved.length >= CUSTOM_ITEM_LIMIT) {
      const message = `自定义物品已经存满 ${CUSTOM_ITEM_LIMIT} 个，先删掉几个再存`;
      this.report(message);
      return { ok: false, message, count: 0 };
    }
    const check = validateCustomItem(this.state, this.existingIds());
    this.validation = check;
    this.problems = check.problems;
    this.renderDerived();
    if (!check.ok || !check.normalized) {
      const message = `还有 ${check.problems.length} 个问题没解决：${check.problems.join('；')}`;
      this.report(message);
      return { ok: false, message, count: 0 };
    }
    const def = check.normalized;
    this.saved.push(def);
    const persisted = this.persist();
    this.renderSaved();
    this.renderDerived();
    // 草稿**不清空**：玩家通常要"存完再微调一次"，清掉反而要重打一遍。
    // 代价是再点一次保存会存成第二个（id 自动加后缀），这一点写在面板的提示里。
    this.handlers.onCreated(def);
    const message = persisted.ok
      ? `已保存「${def.name}」（id：${def.id}），它会出现在物品库的「${def.category}」里`
      : `已保存「${def.name}」，但没能写进本地存储：${persisted.reason}（本次打开期间有效，刷新就没了）`;
    this.report(message, persisted.ok);
    return { ok: true, message, count: 1 };
  }

  /** 从物品库里删掉一个自定义物品。世界里的实例由 Engine 通过 onDeleted 决定怎么办 */
  deleteSaved(defId: string): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    const index = this.saved.findIndex((def) => def.id === defId);
    if (index < 0) {
      const message = `物品库里没有 id 为 ${defId} 的自定义物品`;
      this.report(message);
      return { ok: false, message, count: 0 };
    }
    const removed = this.saved.splice(index, 1)[0]!;
    const persisted = this.persist();
    this.renderSaved();
    this.renderDerived();
    this.handlers.onDeleted(defId);
    const suffix = persisted.ok ? '' : `（没能写进本地存储：${persisted.reason}）`;
    const message = `已从物品库删掉「${removed.name}」${suffix}。${DELETE_NOTE}`;
    this.report(message, true);
    return { ok: true, message, count: 1 };
  }

  // ------------------------------------------------------------------ 导入 / 导出

  /** 从粘贴的 JSON 导入。失败一定给出中文原因，且**一个都不写进列表** */
  importFromText(text: string): CustomItemOpResult {
    if (this.disposed) return { ok: false, message: '编辑器已经关闭', count: 0 };
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed === '') {
      return this.failImport('粘贴框是空的：先把导出的 JSON 贴进来（或者用「选择文件」挑一个 .json）');
    }

    const result = importCustomItems(trimmed, this.existingIds());
    if (result.imported.length === 0) {
      return this.failImport(
        `导入失败，一个都没有导入：${result.problems.length > 0 ? result.problems.join('；') : '文件里没有可用的物品'}`,
      );
    }
    if (this.saved.length + result.imported.length > CUSTOM_ITEM_LIMIT) {
      return this.failImport(
        `本次导入会把自定义物品从 ${this.saved.length} 个变成 ${this.saved.length + result.imported.length} 个，` +
          `超过上限 ${CUSTOM_ITEM_LIMIT}（本地存储会写不进去）。所以一个都没有导入 —— 请先删掉一些再试`,
      );
    }

    this.saved.push(...result.imported);
    const persisted = this.persist();
    this.renderSaved();
    this.renderDerived();
    this.renderExportText();
    const failed = result.problems.length > 0 ? `；另有 ${result.problems.length} 个没能导入：${result.problems.join('；')}` : '';
    const storage = persisted.ok ? '' : `（没能写进本地存储：${persisted.reason}，本次打开期间有效）`;
    const message = `成功导入 ${result.imported.length} 个自定义物品${storage}${failed}`;
    // 部分失败也算"有事发生"，但整体是成功的：用 ok=true 走正常提示，问题清单写在消息里
    this.report(message, true);
    return { ok: true, message, count: result.imported.length };
  }

  /**
   * 从文件导入（`<input type="file">` 走这里）。
   *
   * 刻意写成"非 async + 显式 Promise 链"，为的是让**同步就能判定的失败**
   * （没选文件、这个环境读不了文件、`file.text()` 直接抛）在调用的那一瞬间就报告出去：
   * 面板状态行立刻有中文原因，而不是等一个微任务；断言也才能在同步的 check 里覆盖到它。
   * 只有"读文件真的返回了 promise"这一段是异步的。
   */
  importFromFile(file: File | null): Promise<CustomItemOpResult> {
    if (this.disposed) return Promise.resolve({ ok: false, message: '编辑器已经关闭', count: 0 });
    if (!file) {
      return Promise.resolve(this.failImport('没有选中文件：用「选择文件」挑一个导出的 .json'));
    }
    if (typeof file.text !== 'function') {
      return Promise.resolve(this.failImport('这个环境不支持读取文件内容（File.text 不可用），可以改用下面的粘贴框'));
    }
    let pending: Promise<string>;
    try {
      pending = file.text();
    } catch (error) {
      return Promise.resolve(this.failImport(`读文件失败：${messageOf(error)}`));
    }
    if (typeof pending?.then !== 'function') {
      return Promise.resolve(this.failImport('读文件失败：File.text() 没有返回可等待的结果'));
    }
    return pending.then(
      (text) => this.importFromText(text),
      (error: unknown) => this.failImport(`读文件失败：${messageOf(error)}`),
    );
  }

  /** 导入失败的统一出口：报告 + 返回。失败一定带中文原因，绝不静默 */
  private failImport(message: string): CustomItemOpResult {
    this.report(message);
    return { ok: false, message, count: 0 };
  }

  // ------------------------------------------------------------------ 内部：状态

  private draftCopy(): CustomItemDraft {
    return {
      ...this.state,
      parts: this.state.parts.map((part) => ({
        ...part,
        position: [...part.position] as [number, number, number],
        size: [...part.size] as [number, number, number],
      })),
    };
  }

  /** 已占用的 id（内置物品由 `uniqueId` 自己查目录，这里只要给已有的自定义物品） */
  private existingIds(): Set<string> {
    return new Set(this.saved.map((def) => def.id));
  }

  /** 每次改动都走同一个入口：重新校验 + 重画派生显示。校验器是唯一规则来源 */
  private changed(): void {
    this.validation = validateCustomItem(this.state, this.existingIds());
    this.problems = this.validation.problems;
    this.renderDerived();
  }

  private persist(): { ok: boolean; reason: string } {
    const result = saveCustomItems(this.saved);
    this.storageOutOfSync = !result.ok;
    if (!result.ok) {
      const reason = result.reason ?? '未知原因';
      return { ok: false, reason };
    }
    return { ok: true, reason: '' };
  }

  /** 状态行 + 通知引擎。只在真的失败时调 onError：成功也回调会让这个信号失去意义 */
  private report(message: string, ok = false): void {
    if (this.nodes) {
      this.nodes.ioStatus.textContent = message;
      this.nodes.ioStatus.style.color = ok ? '' : '#e5533d';
    }
    if (!ok) this.handlers.onError?.(message);
  }

  // ------------------------------------------------------------------ 内部：渲染

  private renderDerived(): void {
    const nodes = this.nodes;
    if (!nodes) return;

    const stored = this.storageOutOfSync
      ? `｜⚠ 这个环境写不进本地存储：改动只在本次打开期间有效（刷新就没了）`
      : '';
    nodes.limitNote.textContent =
      `已存 ${this.saved.length} / ${CUSTOM_ITEM_LIMIT} 个自定义物品` +
      (this.saved.length >= CUSTOM_ITEM_LIMIT ? '（已满）' : '') +
      stored;

    nodes.summaryBox.textContent =
      this.state.parts.length === 0
        ? '还没有零件。点「+ 加一个几何体」开始拼。'
        : `零件（按下面的顺序，共 ${this.state.parts.length} / ${CUSTOM_ITEM_MAX_PARTS} 个）：\n` +
          this.state.parts.map(describePart).join('\n') +
          `\n${ORIGIN_NOTE}`;

    nodes.problemsBox.textContent =
      this.problems.length === 0
        ? '✓ 校验通过（规则来自 validateCustomItem，面板不自作判断）'
        : `发现 ${this.problems.length} 个问题：\n` + this.problems.map((problem) => `· ${problem}`).join('\n');

    // 保存按钮的禁用与原因都来自 canSave / saveDisabledReason 这两处，
    // 不在这里再算一遍 —— 两处判断迟早会不一致
    const reason = this.saveDisabledReason;
    nodes.saveButton.disabled = !this.canSave;
    nodes.saveNote.textContent = reason ?? '校验通过：保存后会出现在物品库的对应分类里；草稿会保留，再点一次会存成第二个（id 自动加后缀）。';

    nodes.addButton.disabled = this.state.parts.length >= CUSTOM_ITEM_MAX_PARTS;
    nodes.previewNote.textContent = this.composePreviewText();
    this.drawPreview();
  }

  /** 预览区的文字：WebGL 正常时是说明 + 零件摘要；降级时它**就是**那份摘要（不能是空白） */
  private composePreviewText(): string {
    const head =
      this.previewMode === 'webgl'
        ? '预览已用 WebGL 画出来（⚠ 这条渲染路径在本项目里未经浏览器实测）。下面是当前零件：'
        : `预览不可用：${this.previewReason}。下面用文字摘要代替（参数与保存后的完全一致）：`;
    const lines = this.state.parts.length === 0 ? ['（还没有零件）'] : this.state.parts.map(describePart);
    return [head, ...lines, ORIGIN_NOTE].join('\n');
  }

  /**
   * 整块重画已保存列表。
   * 整块重画而不是逐个更新：条目数量少（≤120 且通常个位数），
   * 而"哪个 DOM 对应哪个物品"的映射是这类面板最常见的不同步来源。
   */
  private renderSaved(): void {
    const nodes = this.nodes;
    if (!nodes) return;
    nodes.savedBox.textContent = '';
    // 导出的文本**先**更新再画列表：空列表会提前 return，写在 return 之后的话
    // "删掉最后一个物品"那一次就不会刷新导出框，玩家复制走的还是已经删掉的那份 JSON
    this.renderExportText();
    if (this.saved.length === 0) {
      nodes.savedBox.appendChild(makeDiv('custom-item-empty')).textContent =
        '还没有保存过自定义物品。';
      return;
    }
    for (const def of this.saved) {
      const row = makeDiv('custom-item-saved-row');
      row.dataset.defId = def.id;
      row.appendChild(
        makeSpan(`${def.icon} ${def.name}｜${def.parts.length} 个零件｜${fmt(def.size[0])}×${fmt(def.size[1])}×${fmt(def.size[2])} 米`),
      );
      const remove = makeButton('删除', 'delete-saved');
      remove.dataset.defId = def.id;
      remove.title = `从物品库删掉「${def.name}」（id：${def.id}）`;
      row.appendChild(remove);
      nodes.savedBox.appendChild(row);
    }
    nodes.savedBox.appendChild(makeDiv('custom-item-note')).textContent = DELETE_NOTE;
  }

  private renderExportText(): void {
    const nodes = this.nodes;
    if (!nodes) return;
    nodes.exportText.value = this.exportText();
  }

  private renderMetaInputs(): void {
    const nodes = this.nodes;
    if (!nodes) return;
    nodes.nameInput.value = this.state.name;
    nodes.categorySelect.value = this.state.category;
    nodes.subcategoryInput.value = this.state.subcategory;
    nodes.iconInput.value = this.state.icon;
    nodes.colorInput.value = hexOf(this.state.color);
    nodes.densityInput.value = String(this.state.density);
    nodes.frictionInput.value = String(this.state.friction);
    nodes.restitutionInput.value = String(this.state.restitution);
    nodes.staticInput.checked = this.state.isStatic;
    nodes.stackableInput.checked = this.state.stackable;
  }

  /** 零件行。只在零件增减时重建；改数值时不重建（否则正在输入的框会丢焦点） */
  private renderParts(): void {
    const nodes = this.nodes;
    if (!nodes) return;
    nodes.partsBox.textContent = '';
    if (this.state.parts.length === 0) {
      const empty = makeDiv('custom-item-empty');
      empty.textContent = '还没有任何几何体。';
      nodes.partsBox.appendChild(empty);
    }
    this.state.parts.forEach((part, index) => nodes.partsBox.appendChild(this.buildPartRow(part, index)));
    nodes.addButton.disabled = this.state.parts.length >= CUSTOM_ITEM_MAX_PARTS;
  }

  private buildPartRow(part: BuildingPart, index: number): HTMLElement {
    const row = makeDiv('custom-item-part');
    row.dataset.partIndex = String(index);
    row.appendChild(makeSpan(`第 ${index + 1} 个`, 'custom-item-part-index'));

    const shape = document.createElement('select');
    shape.dataset.customItemField = 'shape';
    shape.dataset.partIndex = String(index);
    fillSelect(
      shape,
      CUSTOM_SHAPES.map((value) => ({ value, label: shapeLabel(value) })),
    );
    shape.value = part.shape;
    row.appendChild(makeField('形状', shape));

    row.appendChild(this.buildAxisGroup(index, 'position', '位置 XYZ', part.position));
    row.appendChild(this.buildAxisGroup(index, 'size', '尺寸 XYZ', part.size));

    const color = makeColorInput(part.color);
    color.dataset.customItemField = 'color';
    color.dataset.partIndex = String(index);
    row.appendChild(makeField('颜色', color));

    const remove = makeButton('删掉', 'remove-part');
    remove.dataset.partIndex = String(index);
    row.appendChild(remove);
    return row;
  }

  private buildAxisGroup(index: number, field: PartNumberField, title: string, values: readonly number[]): HTMLElement {
    const group = makeDiv('custom-item-axis-group');
    group.appendChild(makeSpan(title, 'custom-item-field-title'));
    for (const axis of [0, 1, 2] as const) {
      const input = makeNumberInput();
      input.dataset.customItemField = field;
      input.dataset.partIndex = String(index);
      input.dataset.axis = String(axis);
      input.title = field === 'size' ? '单位：米（单边最多 50 米，由校验器判定）' : '单位：米（相对底面中心）';
      const raw = values[axis];
      // 数值坏掉时输入框留空（而不是显示 NaN 或硬塞 0）：空串交给校验器报错，
      // 硬塞 0 会让玩家以为"是我写的"。
      input.value = raw !== undefined && Number.isFinite(raw) ? String(raw) : '';
      group.appendChild(input);
    }
    return group;
  }

  // ------------------------------------------------------------------ 内部：DOM 骨架

  /**
   * 找约定里的 `#custom-item-preview`。
   *
   * 三个位置依次找：容器里 → 容器的父节点里 → 整个文档里。
   * 放开到"父节点 / document"是因为 HTML 片段在并发编辑中由别人维护，
   * canvas 放在容器里还是紧跟在容器后面本来是排版偏好，不该决定这个功能能不能用。
   * （每个 scope 都先看 querySelector 在不在：桩 DOM 里可能根本没有这个方法。）
   */
  private findPreviewCanvas(container: HTMLElement): HTMLCanvasElement | null {
    const scopes: (ParentNode | null)[] = [
      container,
      container.parentElement,
      typeof document === 'undefined' ? null : document,
    ];
    for (const scope of scopes) {
      if (!scope || typeof scope.querySelector !== 'function') continue;
      const found = scope.querySelector<HTMLCanvasElement>('#custom-item-preview');
      if (found) return found;
    }
    return null;
  }

  private buildEditor(container: HTMLElement): EditorNodes {
    // 先把约定里的预览 canvas 找出来、再清空容器 —— 顺序反了的话
    // `textContent = ''` 会把它一起删掉，之后只能自己新建一个，
    // 那 HTML 片段里写的那句"最低需要 #custom-item-preview"就等于白写。
    const declared = this.findPreviewCanvas(container);
    container.textContent = '';
    const root = makeDiv('custom-item-editor');
    root.dataset.customItemRole = 'editor';
    container.appendChild(root);

    root.appendChild(makeSpan('🧰 自定义物品编辑器', 'custom-item-title'));
    const limitNote = makeDiv('custom-item-note');
    limitNote.dataset.customItemRole = 'limit-note';
    root.appendChild(limitNote);

    // ---- 元信息 ----
    const metaBox = makeDiv('custom-item-meta');
    const nameInput = makeTextInput('例如：三层书架', 24);
    nameInput.dataset.customItemField = 'name';
    metaBox.appendChild(makeField('名称', nameInput));

    const categorySelect = document.createElement('select');
    categorySelect.dataset.customItemField = 'category';
    fillSelect(
      categorySelect,
      BUILDING_CATEGORIES.map((info) => ({ value: info.id, label: `${info.icon} ${info.name}` })),
    );
    metaBox.appendChild(makeField('分类', categorySelect));

    const subcategoryInput = makeTextInput('自定义');
    subcategoryInput.dataset.customItemField = 'subcategory';
    metaBox.appendChild(makeField('二级分类', subcategoryInput));

    const iconInput = makeTextInput('📦');
    iconInput.dataset.customItemField = 'icon';
    metaBox.appendChild(makeField('图标 emoji', iconInput));

    const colorInput = makeColorInput(this.state.color);
    colorInput.dataset.customItemField = 'color';
    metaBox.appendChild(makeField('主色', colorInput));

    const densityInput = makeNumberInput();
    densityInput.dataset.customItemField = 'density';
    metaBox.appendChild(makeField('密度 kg/m³', densityInput));

    const frictionInput = makeNumberInput();
    frictionInput.dataset.customItemField = 'friction';
    metaBox.appendChild(makeField('摩擦 0~1', frictionInput));

    const restitutionInput = makeNumberInput();
    restitutionInput.dataset.customItemField = 'restitution';
    metaBox.appendChild(makeField('弹性 0~1', restitutionInput));

    const staticBox = makeCheckbox('默认静态（放着不动）', this.state.isStatic);
    staticBox.input.dataset.customItemField = 'isStatic';
    metaBox.appendChild(staticBox.label);
    const stackBox = makeCheckbox('可堆叠（能被压）', this.state.stackable);
    stackBox.input.dataset.customItemField = 'stackable';
    metaBox.appendChild(stackBox.label);

    metaBox.appendChild(makeDiv('custom-item-note')).textContent =
      '不填质量：保存时按"包围盒体积 × 密度"自动算（这一步在 validateCustomItem 里做）。';
    root.appendChild(metaBox);

    // ---- 零件区 ----
    root.appendChild(makeSpan('几何体零件', 'custom-item-section-title'));
    const partTools = makeDiv('custom-item-tools');
    const shapeSelect = document.createElement('select');
    fillSelect(
      shapeSelect,
      CUSTOM_SHAPES.map((value) => ({ value, label: shapeLabel(value) })),
    );
    partTools.appendChild(makeField('新零件形状', shapeSelect));
    const addButton = makeButton('+ 加一个几何体', 'add-part');
    partTools.appendChild(addButton);
    root.appendChild(partTools);
    const partsBox = makeDiv('custom-item-parts');
    partsBox.dataset.customItemRole = 'parts';
    root.appendChild(partsBox);

    const summaryBox = makeDiv('custom-item-summary');
    summaryBox.dataset.customItemRole = 'summary';
    // pre-wrap：摘要每行一个零件，默认的 white-space 会把换行折叠成一整行
    summaryBox.style.whiteSpace = 'pre-wrap';
    root.appendChild(summaryBox);

    // ---- 校验 ----
    const problemsBox = makeDiv('custom-item-problems');
    problemsBox.dataset.customItemRole = 'problems';
    problemsBox.style.whiteSpace = 'pre-wrap';
    root.appendChild(problemsBox);

    // ---- 预览 ----
    root.appendChild(makeSpan('预览', 'custom-item-section-title'));
    // 用 HTML 片段里那个 canvas；没有再自己建一个（面板不该因为少个节点就整块不可用）。
    // 找到的那个节点会被重新挂进 root：容器被清空过，它现在是个游离节点。
    let previewCanvas = declared;
    if (!previewCanvas) {
      previewCanvas = document.createElement('canvas');
      previewCanvas.id = 'custom-item-preview';
      previewCanvas.width = PREVIEW_WIDTH;
      previewCanvas.height = PREVIEW_HEIGHT;
      previewCanvas.style.width = '100%';
      previewCanvas.style.height = `${PREVIEW_HEIGHT}px`;
      previewCanvas.style.display = 'block';
    }
    previewCanvas.dataset.customItemRole = 'preview-canvas';
    root.appendChild(previewCanvas);
    const previewNote = makeDiv('custom-item-note');
    previewNote.dataset.customItemRole = 'preview-note';
    previewNote.style.whiteSpace = 'pre-wrap';
    root.appendChild(previewNote);

    // ---- 保存 ----
    const saveRow = makeDiv('custom-item-tools');
    const saveButton = makeButton('保存到物品库', 'save');
    saveButton.dataset.customItemRole = 'save-button';
    saveRow.appendChild(saveButton);
    const saveNote = makeDiv('custom-item-note');
    saveNote.dataset.customItemRole = 'save-note';
    saveRow.appendChild(saveNote);
    root.appendChild(saveRow);

    // ---- 已保存列表 ----
    root.appendChild(makeSpan('已经保存的自定义物品', 'custom-item-section-title'));
    const savedBox = makeDiv('custom-item-saved');
    savedBox.dataset.customItemRole = 'saved-list';
    root.appendChild(savedBox);

    // ---- 导入 / 导出 ----
    root.appendChild(makeSpan('导入 / 导出', 'custom-item-section-title'));
    const ioBox = makeDiv('custom-item-io');
    const exportText = document.createElement('textarea');
    exportText.readOnly = true;
    exportText.rows = 4;
    exportText.dataset.customItemRole = 'export-text';
    exportText.title = '这里是全部自定义物品的 JSON：全选复制走即可，别人贴进「导入」就能拿到同样的物品';
    ioBox.appendChild(makeField('导出的 JSON', exportText));
    const downloadButton = makeButton('下载成 .json 文件', 'download');
    ioBox.appendChild(downloadButton);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.dataset.customItemRole = 'import-file';
    ioBox.appendChild(makeField('从文件导入', fileInput));

    const pasteText = document.createElement('textarea');
    pasteText.rows = 4;
    pasteText.placeholder = '把别人给的 JSON 贴在这里，然后点右边的「导入这段 JSON」';
    pasteText.dataset.customItemRole = 'import-text';
    const importButton = makeButton('导入这段 JSON', 'import-paste');
    ioBox.appendChild(makeField('粘贴 JSON', pasteText));
    ioBox.appendChild(importButton);

    const ioStatus = makeDiv('custom-item-status');
    ioStatus.dataset.customItemRole = 'io-status';
    ioBox.appendChild(ioStatus);
    ioBox.appendChild(makeDiv('custom-item-note')).textContent = LIMITATIONS_NOTE;
    root.appendChild(ioBox);

    return {
      root,
      limitNote,
      metaBox,
      nameInput,
      categorySelect,
      subcategoryInput,
      iconInput,
      colorInput,
      densityInput,
      frictionInput,
      restitutionInput,
      staticInput: staticBox.input,
      stackableInput: stackBox.input,
      shapeSelect,
      addButton,
      partsBox,
      summaryBox,
      problemsBox,
      previewCanvas,
      previewNote,
      saveButton,
      saveNote,
      savedBox,
      exportText,
      downloadButton,
      fileInput,
      pasteText,
      importButton,
      ioStatus,
    };
  }

  // ------------------------------------------------------------------ 内部：事件

  private on(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    // 记下来：dispose() 时逐个摘掉。委托挂在容器上，所以哪怕行被重建也不会漏
    this.listeners.push({ target, type, handler });
  }

  private bindEvents(nodes: EditorNodes): void {
    // 元信息：'input' 覆盖文本框实时输入，'change' 覆盖下拉与复选框
    this.on(nodes.metaBox, 'input', (ev) => this.onMetaEvent(ev));
    this.on(nodes.metaBox, 'change', (ev) => this.onMetaEvent(ev));
    // 零件行：行会被重建，所以一律走容器委托
    this.on(nodes.partsBox, 'input', (ev) => this.onPartEvent(ev));
    this.on(nodes.partsBox, 'change', (ev) => this.onPartEvent(ev));

    this.on(nodes.addButton, 'click', () => {
      // 新零件形状只认 CUSTOM_SHAPES 里真实存在的值（下拉框被改过就退回方块）
      const picked = nodes.shapeSelect.value as BuildingPartShape;
      const shape = CUSTOM_SHAPES.includes(picked) ? picked : 'box';
      const result = this.addPart(shape);
      if (!result.ok) this.report(result.message);
    });

    this.on(nodes.partsBox, 'click', (ev) => {
      const action = (ev.target as HTMLElement | null)?.dataset.customItemAction;
      if (action !== 'remove-part') return;
      const index = Number((ev.target as HTMLElement | null)?.dataset.partIndex);
      const result = this.removePart(index);
      if (!result.ok) this.report(result.message);
    });

    this.on(nodes.savedBox, 'click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.dataset.customItemAction !== 'delete-saved') return;
      this.deleteSaved(target.dataset.defId ?? '');
    });

    this.on(nodes.saveButton, 'click', () => {
      this.save();
    });

    this.on(nodes.importButton, 'click', () => {
      this.importFromText(nodes.pasteText.value);
    });

    this.on(nodes.fileInput, 'change', () => {
      const file = nodes.fileInput.files?.[0] ?? null;
      // 结果由 importFromFile 自己写进状态行；这里的 then 只是兜住"读文件真的异步失败"的拒绝，
      // 不让它变成没人处理的 promise 异常
      void this.importFromFile(file).catch((error: unknown) => {
        this.report(`读文件时出了意外：${messageOf(error)}`);
      });
    });

    this.on(nodes.downloadButton, 'click', () => this.downloadExport());
  }

  private onMetaEvent(ev: Event): void {
    const target = ev.target as (HTMLInputElement | HTMLSelectElement) | null;
    const key = target?.dataset.customItemField as MetaField | undefined;
    if (!target || !key) return;
    // 复选框送的是 checked，其余送 value。只认 isStatic / stackable 这两个开关字段，
    // 别的键一律当文本处理（DOM 被改过也不会把 true 塞进名称里）
    const isSwitch = key === 'isStatic' || key === 'stackable';
    const value: string | boolean = isSwitch ? (target as HTMLInputElement).checked : target.value;
    this.setMeta(key, value);
  }

  private onPartEvent(ev: Event): void {
    const target = ev.target as (HTMLInputElement | HTMLSelectElement) | null;
    const field = target?.dataset.customItemField;
    const index = Number(target?.dataset.partIndex);
    if (!target || !field || !Number.isInteger(index)) return;
    if (field === 'shape') {
      this.setPart(index, { shape: target.value as BuildingPartShape });
      return;
    }
    if (field === 'color') {
      const result = this.setPartColorHex(index, target.value);
      if (!result.ok) return; // 拒绝时颜色保持原样，输入框也保持在原值上
      target.value = hexOf(this.state.parts[index]?.color ?? this.state.color);
      return;
    }
    if (field === 'position' || field === 'size') {
      const axis = Number(target.dataset.axis);
      if (axis !== 0 && axis !== 1 && axis !== 2) return;
      // 空串 → 0；浏览器对非法数字的输入框也给空串。两个都会进草稿，
      // 由校验器来说"尺寸必须是三个正数" —— 这里不做二次判断
      this.setPartNumber(index, field, axis, target.value === '' ? 0 : Number(target.value));
    }
  }

  /** 下载导出的 JSON。环境不支持时如实说明，而不是点了没反应 */
  private downloadExport(): void {
    const text = this.exportText();
    const nodes = this.nodes;
    if (nodes) nodes.exportText.value = text;
    try {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('这个环境不支持文件下载（URL.createObjectURL 不可用）');
      }
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'god-sandbox-custom-items.json';
      link.click();
      URL.revokeObjectURL(url);
      this.report(`已导出 ${this.saved.length} 个自定义物品（god-sandbox-custom-items.json）`, true);
    } catch (error) {
      const message = `导出文件失败：${messageOf(error)}。可以直接复制上面文本框里的 JSON，效果一样`;
      this.report(message);
    }
  }

  // ------------------------------------------------------------------ 内部：预览

  private initPreview(canvas: HTMLCanvasElement | null): void {
    if (!canvas) {
      this.previewMode = 'text';
      this.previewReason = 'HTML 里没有 #custom-item-preview 这个 canvas';
      return;
    }
    // 先自己取上下文：three 的 WebGLRenderer 拿不到上下文时会抛异常，
    // 而"建了再 catch"留下的是半个实例。判不出来就永远走文字降级。
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    } catch (error) {
      this.previewReason = `取 WebGL 上下文时抛异常：${messageOf(error)}`;
    }
    if (!gl) {
      this.previewMode = 'text';
      if (this.previewReason === '还没有初始化预览') {
        this.previewReason = '这个环境拿不到 WebGL 上下文（没有 GPU / 浏览器禁用了 WebGL / 在 Node 里跑）';
      }
      return;
    }

    try {
      const renderer = new WebGLRenderer({ canvas, context: gl as WebGLRenderingContext, antialias: true });
      // 先把它记到字段上再接下去建场景：后面任何一步失败都能被 disposePreview() 收回来。
      // 只在 try 外面记的话，失败时这个渲染器就成了谁也拿不到的孤儿。
      this.renderer = renderer;
      // updateStyle = false：画布的 CSS 尺寸由 HTML 片段给（width:100%），
      // 让它跟着绘制缓冲一起被改会把手写的样式冲掉
      const width = Math.max(120, canvas.clientWidth || PREVIEW_WIDTH);
      const height = Math.max(80, canvas.clientHeight || PREVIEW_HEIGHT);
      // 刻意不调 setPixelRatio：预览是静态小图，按 DPR 放大只会白花手机上的填充率
      renderer.setSize(width, height, false);
      const scene = new Scene();
      const camera = new PerspectiveCamera(45, width / height, 0.1, 500);
      camera.position.set(3.2, 2.6, 4.2);
      camera.lookAt(0, 0.6, 0);
      // 只有方向光的话背面全黑，加一盏环境光让玩家看清每个零件的颜色
      scene.add(new AmbientLight(0xffffff, 1.6));
      const sun = new DirectionalLight(0xffffff, 2.2);
      sun.position.set(4, 6, 3);
      scene.add(sun);
      // 原点标记：网格铺在 y=0，坐标轴从原点伸出。
      // 这不是装饰 —— "原点在底面中心"是本项目的硬约定，玩家必须看得见自己拼的东西
      // 站在哪里、有没有一半陷在地面下面。
      scene.add(new GridHelper(4, 8, 0x4aa3ff, 0x445566));
      scene.add(new AxesHelper(1));
      const group = new Group();
      scene.add(group);

      this.renderer = renderer;
      this.previewScene = scene;
      this.previewCamera = camera;
      this.previewGroup = group;
      this.previewMode = 'webgl';
      this.previewReason = 'WebGL 上下文正常（⚠ 这条渲染路径未经浏览器实测）';
    } catch (error) {
      this.previewMode = 'text';
      this.previewReason = `预览渲染器创建失败：${messageOf(error)}`;
      this.disposePreview();
    }
  }

  /** 画当前零件。校验通过时画**规范化后的**零件（那才是会被真正放下去的形状，整体已贴到 y=0） */
  private drawPreview(): void {
    const renderer = this.renderer;
    const scene = this.previewScene;
    const camera = this.previewCamera;
    const group = this.previewGroup;
    if (!renderer || !scene || !camera || !group) return;
    this.clearPreviewParts();
    const parts = this.validation.ok && this.validation.normalized ? this.validation.normalized.parts : this.state.parts;
    for (const part of parts) group.add(makePartMesh(part));
    // 只在改动时画一帧，不起 requestAnimationFrame 循环：
    // 一个静态预览没必要占满帧预算，而这个面板是跟主渲染循环共用主线程的
    renderer.render(scene, camera);
  }

  /** 清掉上一帧的零件。几何体与材质都要 dispose，否则每改一次参数就漏一份显存 */
  private clearPreviewParts(): void {
    const group = this.previewGroup;
    if (!group) return;
    while (group.children.length > 0) {
      const child = group.children[0]!;
      group.remove(child);
      const mesh = child as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else if (material) {
        material.dispose();
      }
    }
  }

  private disposePreview(): void {
    this.clearPreviewParts();
    const scene = this.previewScene;
    if (scene) {
      // 网格与坐标轴的几何体 / 材质也要释放：它们和零件一样占显存。
      // 灯光没有 geometry / material，下面的取字段会自然跳过。
      scene.traverse((object) => {
        const mesh = object as Partial<Mesh>;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const item of material) item.dispose();
        } else if (material) {
          material.dispose();
        }
      });
      scene.clear();
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.previewScene = null;
    this.previewCamera = null;
    this.previewGroup = null;
  }
}
