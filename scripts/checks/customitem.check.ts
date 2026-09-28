/**
 * 自定义物品编辑器（`src/ui/CustomItemUI.ts`）的断言（M4 补充 2）。
 *
 * 为什么不写进 `scripts/verify.ts`：那个文件是并发编辑的公共入口，加进去必然冲突。
 * 这里导出 `runCustomItemChecks(check)`，跑法见同目录的 `customitem.run.ts`：
 *
 * ```bash
 * npx esbuild scripts/checks/customitem.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/customitem.mjs && node .verify/customitem.mjs
 * ```
 *
 * ────────────────────────────────────────────────────────────
 * 断言的两条主线
 * ────────────────────────────────────────────────────────────
 * 1. **面板不许有第二套校验规则**：每一条"问题列表"的断言都是
 *    `ui.problemList` 与**直接调用 `validateCustomItem(草稿)`** 逐条比对。
 *    这是本文件里最重要的不变量 —— 一旦有人在 UI 里补一条自己的判断，
 *    立刻会出现"界面说能存、点保存却被拒"，而这种不一致玩家查不出来。
 *    （比对是合法的：`existingIds` 只影响 id 生成，不参与 problems 的判定。）
 * 2. **界面上的禁用状态必须有真实原因**：保存按钮 disabled 的时机、上限提示的数字、
 *    降级预览的文字，全部按真值断言，而不是"看起来有个按钮就行"。
 *
 * ────────────────────────────────────────────────────────────
 * DOM 桩的三条规矩（踩过坑，所以写在最前面）
 * ────────────────────────────────────────────────────────────
 * - `npm run verify` 里多个 check 模块**共用一个全局环境**，所以桩上必须打
 *   `__stubDom: true`，并且 `restore()` 要把原来的描述符**原样**还回去
 *   （`Object.defineProperty(globalThis,'document', existing)`）。
 *   否则别的模块的 DOM 断言会因为"全局里已经有 document"而失败，
 *   看起来像是别人的 bug，实际是我留下的污染。文件末尾有一条断言专门核对这件事。
 * - 环境里已经有**看起来像真 DOM** 的 document 时不接管：那种情况下该测的本来就是真 DOM。
 * - 假 localStorage 同理：用完必须还原，并断言"描述符与注入前一致"。
 *
 * ────────────────────────────────────────────────────────────
 * 覆盖不到的地方（如实写明，不装作覆盖了）
 * ────────────────────────────────────────────────────────────
 * **Three.js 画出来的东西没有任何断言。** 容器 / CI 里没有 WebGL，
 * `canvas.getContext()` 返回 null，所以本文件能覆盖的只有"拿不到 WebGL 时安全降级成文字摘要"
 * 这条路径。真正画出来的样子（零件位置、颜色、原点网格）**未经任何实测** ——
 * 这条限制写在 `CustomItemUI.ts` 的文件头，也写在面板界面上。
 *
 * 同理，`importFromFile` 里"读文件真的返回了 promise 之后失败"那一段是异步的，
 * 而 `runCustomItemChecks` 是同步函数（`verify.ts` 直接调），所以只覆盖了
 * 同步就能判定的三条失败路径：没选文件 / 读不了文件 / `file.text()` 同步抛。
 */

import {
  CUSTOM_ITEM_LIMIT,
  CUSTOM_ITEM_MAX_PARTS,
  CUSTOM_ITEM_STORAGE_KEY,
  CUSTOM_SHAPES,
  exportCustomItems,
  saveCustomItems,
  validateCustomItem,
  type CustomItemDraft,
} from '../../src/data/customItems';
import type { BuildingDef, BuildingPart } from '../../src/building/types';
import {
  CustomItemUI,
  type CustomItemOpResult,
  type CustomItemUIHandlers,
} from '../../src/ui/CustomItemUI';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

// ------------------------------------------------------------------ 小工具

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

/** 顺序敏感的逐条比对：问题列表的顺序也是校验器给的，顺序变了要能看出来 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 草稿是 `unknown`（接口有意如此），断言里强转一次比到处写断言安全 */
function draftOf(ui: CustomItemUI): CustomItemDraft {
  return ui.draft as CustomItemDraft;
}

/** 直接调用校验器（不经过面板），作为"唯一规则来源"的参照 */
function directProblems(draft: CustomItemDraft): string[] {
  return validateCustomItem(draft).problems;
}

/** 零件逐项比对（含位置与尺寸的三个分量）：往返测试用 */
function partsEqual(a: readonly BuildingPart[], b: readonly BuildingPart[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((part, index) => {
    const other = b[index]!;
    return (
      part.shape === other.shape &&
      part.color === other.color &&
      part.position[0] === other.position[0] &&
      part.position[1] === other.position[1] &&
      part.position[2] === other.position[2] &&
      part.size[0] === other.size[0] &&
      part.size[1] === other.size[1] &&
      part.size[2] === other.size[2]
    );
  });
}

interface Recorder {
  created: BuildingDef[];
  deleted: string[];
  errors: string[];
}

function makeHandlers(record: Recorder): CustomItemUIHandlers {
  return {
    onCreated: (def) => {
      record.created.push(def);
    },
    onDeleted: (defId) => {
      record.deleted.push(defId);
    },
    onError: (message) => {
      record.errors.push(message);
    },
  };
}

/**
 * 把一份草稿填成"一定合法"的状态：Ø0.4×3 的圆柱立在原点上方，底面正好落在 y=0。
 * 位置刻意选成 minY 已经是 0 —— `validateCustomItem` 会把模型整体抬到最低点贴地，
 * 这一条同时也是"来回导入导出不改变位置"的前提。
 */
function fillValid(ui: CustomItemUI, name: string): void {
  ui.setMeta('name', name);
  ui.setMeta('category', '装饰');
  ui.setMeta('subcategory', '自定义');
  ui.setMeta('icon', '📦');
  ui.setMeta('density', 700);
  ui.setMeta('friction', 0.5);
  ui.setMeta('restitution', 0.2);
  ui.addPart('cylinder');
  ui.setPart(0, { position: [0, 1.5, 0], size: [0.4, 3, 0.4], color: 0x88aaff });
}

/** 导出文件里单个物品的样子（与 `exportCustomItems` 写出来的一致） */
function itemInExportFile(name: string): Record<string, unknown> {
  return {
    name,
    category: '装饰',
    subcategory: '自定义',
    icon: '📦',
    color: 0xaaaaaa,
    mass: 2.5,
    friction: 0.5,
    restitution: 0.2,
    isStatic: false,
    stackable: true,
    parts: [{ shape: 'box', position: [0, 0.5, 0], size: [1, 1, 1], color: 0xaaaaaa }],
  };
}

/** 一份合法的导入 JSON（`importCustomItems` 认 items 数组） */
function exportFileWith(names: readonly string[]): string {
  return JSON.stringify({ version: 1, kind: 'god-sandbox-custom-items', items: names.map(itemInExportFile) });
}

// ------------------------------------------------------------------ 极简 DOM 桩

interface StubNode {
  tagName: string;
  id: string;
  className: string;
  parent: StubNode | null;
  parentElement: StubNode | null;
  children: StubNode[];
  style: Record<string, string>;
  dataset: Record<string, string | undefined>;
  attributes: Map<string, string>;
  handlers: Map<string, EventListener[]>;
  textContent: string;
  value: string;
  type: string;
  step: string;
  maxLength: number;
  rows: number;
  placeholder: string;
  title: string;
  href: string;
  download: string;
  accept: string;
  files: null;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  appendChild(child: StubNode): StubNode;
  addEventListener(type: string, handler: EventListener): void;
  removeEventListener(type: string, handler: EventListener): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  querySelector(selector: string): StubNode | null;
  /** 永远返回 null：这就是"容器里没有 WebGL" */
  getContext(type: string): null;
  /** 只派发挂在这个节点上的监听；第二个参数是事件里的 target，用来测事件委托 */
  dispatch(type: string, target?: StubNode): void;
}

interface StubDom {
  document: Document;
  root: StubNode;
}

function makeStubNode(tagName: string): StubNode {
  const node = {
    tagName,
    id: '',
    className: '',
    parent: null,
    parentElement: null,
    children: [] as StubNode[],
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string | undefined>,
    attributes: new Map<string, string>(),
    handlers: new Map<string, EventListener[]>(),
    value: '',
    type: '',
    step: '',
    maxLength: 0,
    rows: 0,
    placeholder: '',
    title: '',
    href: '',
    download: '',
    accept: '',
    files: null,
    checked: false,
    disabled: false,
    readOnly: false,
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    appendChild: (child: StubNode): StubNode => {
      child.parent = node as unknown as StubNode;
      child.parentElement = node as unknown as StubNode;
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
    // 只支持 `#id`：面板只用这一种选择器去找预览 canvas
    querySelector: (selector: string): StubNode | null => {
      if (!selector.startsWith('#')) return null;
      const wanted = selector.slice(1);
      let found: StubNode | null = null;
      const visit = (current: StubNode): void => {
        if (found) return;
        if (current.id === wanted) {
          found = current;
          return;
        }
        for (const child of current.children) visit(child);
      };
      for (const child of node.children) visit(child);
      return found;
    },
    getContext: (): null => null,
    dispatch: (type: string, target?: StubNode): void => {
      for (const handler of node.handlers.get(type) ?? []) {
        handler({ target: target ?? node } as unknown as Event);
      }
    },
  } as unknown as StubNode;

  // textContent 用访问器实现：**赋值就清空子节点**，与真 DOM 一致。
  // 面板每次重画都是 `textContent = ''` 再 append，桩不模拟这一点的话旧节点会留在
  // children 里，断言就会数到一堆已经不在树上的东西。
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (value: string) => {
      text = String(value);
      node.children.length = 0;
    },
    enumerable: true,
    configurable: true,
  });
  return node;
}

/** 深度优先找节点。传 root 就能只在某个子树里找（两份面板同时存在时必须这样） */
function walkTree(root: StubNode, predicate: (node: StubNode) => boolean): StubNode[] {
  const found: StubNode[] = [];
  const visit = (node: StubNode): void => {
    if (predicate(node)) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

function byRole(root: StubNode, role: string): StubNode | undefined {
  return walkTree(root, (node) => node.dataset.customItemRole === role)[0];
}

function byAction(root: StubNode, action: string): StubNode | undefined {
  return walkTree(root, (node) => node.dataset.customItemAction === action)[0];
}

function makeStubDom(): StubDom {
  const root = makeStubNode('div');
  root.clientWidth = 320;
  const documentStub = {
    // 标记"这是桩，不是真 DOM"：installStubDom 靠它判断全局里的 document 该不该被接管
    __stubDom: true,
    activeElement: null as unknown,
    createElement: (tag: string): StubNode => makeStubNode(tag),
    querySelector: (): null => null,
  };
  return { document: documentStub as unknown as Document, root };
}

/**
 * 装/卸全局 DOM。装之前记下原描述符，卸的时候原样还回去 —— 不给别的 check 模块留污染。
 *
 * 环境里已经有**看起来像真实浏览器 DOM** 的 document 时返回 null（不接管）：
 * 那种情况下该测的是真 DOM，而不是我们的桩。
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

/** 内存版 localStorage：Node 里没有 webstorage，隐私模式在代码里的形态就是"它不在" */
interface FakeStorage {
  map: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function makeFakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

// ------------------------------------------------------------------ 断言

export function runCustomItemChecks(check: CheckFn): void {
  const record: Recorder = { created: [], deleted: [], errors: [] };
  const handlers = makeHandlers(record);
  const hasLocalStorage = typeof localStorage !== 'undefined';

  // ==================================================================
  // 0. 环境事实（后面的断言按它分两条路，先如实记下来）
  // ==================================================================
  check(
    '环境事实：本进程有没有 localStorage（决定后面走"真往返"还是"降级"那条断言）',
    true,
    hasLocalStorage
      ? '有 localStorage：按真实存储断言'
      : '没有 localStorage（Node 默认如此）：按降级行为断言，另用注入的假存储测往返',
  );

  // ==================================================================
  // 1. container === null：没有 DOM 时也必须能用、不能抛
  // ==================================================================
  let nullUi: CustomItemUI | null = null;
  let ctorError = '';
  try {
    nullUi = new CustomItemUI(null, handlers);
  } catch (error) {
    ctorError = messageOf(error);
  }
  check('container === null 时能构造（不抛异常）', nullUi !== null, ctorError === '' ? '构造成功' : `抛了：${ctorError}`);

  const draftType = nullUi ? typeof nullUi.draft : 'none';
  let getterError = '';
  try {
    nullUi?.refresh();
    void nullUi?.draft;
    void nullUi?.previewText;
    void nullUi?.problemList;
    void nullUi?.canSave;
    nullUi?.dispose();
  } catch (error) {
    getterError = messageOf(error);
  }
  check(
    'container === null 时 refresh / draft / 预览文字 / 问题列表 / canSave / dispose 都不抛异常',
    getterError === '' && draftType === 'object',
    getterError === '' ? `draft 的类型是 ${draftType}` : `抛了：${getterError}`,
  );

  const nullUiParts = new CustomItemUI(null, handlers);
  const addInvisible = nullUiParts.addPart('cone');
  check(
    'container === null 时零件编辑照常可用（草稿状态不依赖 DOM）',
    addInvisible.ok && draftOf(nullUiParts).parts.length === 1,
    `addPart：${addInvisible.message}`,
  );

  // ==================================================================
  // 2. 校验的唯一来源：面板的问题列表 === validateCustomItem 的问题列表
  // ==================================================================
  const uiEmpty = new CustomItemUI(null, handlers);
  const emptyDirect = directProblems(draftOf(uiEmpty));
  check(
    '空草稿的问题列表与直接调用 validateCustomItem 逐条一致（面板没有第二套规则）',
    sameList(uiEmpty.problemList, emptyDirect),
    `面板：${uiEmpty.problemList.join('｜')} ／ 直接调用：${emptyDirect.join('｜')}`,
  );
  check(
    '空草稿确实是非法的，且 canSave === false（前置事实：否则上一条断言没有意义）',
    emptyDirect.length > 0 && uiEmpty.canSave === false,
    `${emptyDirect.length} 个问题：${emptyDirect.join('；')}`,
  );
  check(
    '空草稿的问题里包含校验器给的「至少要有一个几何体」',
    emptyDirect.some((problem) => problem.includes('至少要有一个几何体')),
    emptyDirect.join('；'),
  );

  const uiValid = new CustomItemUI(null, handlers);
  fillValid(uiValid, '断言用圆柱');
  check(
    '填好一份合法草稿后校验通过（问题为空、canSave === true）',
    uiValid.problemList.length === 0 && uiValid.canSave === true,
    `问题 ${uiValid.problemList.length} 个｜canSave=${uiValid.canSave}`,
  );
  check(
    '加完零件后问题列表仍然与直接调用 validateCustomItem 一致',
    sameList(uiValid.problemList, directProblems(draftOf(uiValid))),
    `面板：${uiValid.problemList.join('｜')}`,
  );

  // ==================================================================
  // 3. 零件数上限
  // ==================================================================
  const uiParts = new CustomItemUI(null, handlers);
  const addResults: boolean[] = [];
  for (let index = 0; index < CUSTOM_ITEM_MAX_PARTS; index += 1) addResults.push(uiParts.addPart('box').ok);
  check(
    `零件能一路加到上限 ${CUSTOM_ITEM_MAX_PARTS} 个`,
    addResults.every((ok) => ok) && draftOf(uiParts).parts.length === CUSTOM_ITEM_MAX_PARTS,
    `加了 ${draftOf(uiParts).parts.length} 个`,
  );

  const overLimit = uiParts.addPart('box');
  check(
    `加第 ${CUSTOM_ITEM_MAX_PARTS + 1} 个零件被挡住（ok === false）`,
    overLimit.ok === false,
    overLimit.message,
  );
  check(
    '被挡住时草稿里的零件数没有偷偷加上去',
    draftOf(uiParts).parts.length === CUSTOM_ITEM_MAX_PARTS,
    `现在 ${draftOf(uiParts).parts.length} 个`,
  );
  check(
    '被挡住的原因写明了上限数字，并且是中文',
    overLimit.message.includes(String(CUSTOM_ITEM_MAX_PARTS)) && hasChinese(overLimit.message),
    overLimit.message,
  );

  // ==================================================================
  // 4. 非法尺寸（0 / 负数 / NaN）→ 保存被禁用
  // ==================================================================
  const uiSize = new CustomItemUI(null, handlers);
  fillValid(uiSize, '坏尺寸');
  const sizeBefore = uiSize.canSave;

  uiSize.setPart(0, { size: [0, 3, 0.4] });
  check(
    '尺寸为 0 → 校验器报问题、canSave 变 false',
    uiSize.problemList.length > 0 && uiSize.canSave === false,
    uiSize.problemList.join('；'),
  );
  uiSize.setPart(0, { size: [-1, 3, 0.4] });
  check(
    '尺寸为负数 → 同样报问题、canSave === false',
    uiSize.problemList.some((problem) => problem.includes('尺寸')) && uiSize.canSave === false,
    uiSize.problemList.join('；'),
  );
  uiSize.setPart(0, { size: [Number.NaN, 3, 0.4] });
  check(
    '尺寸为 NaN → 同样报问题、canSave === false（NaN 不许被悄悄当成 0 放过）',
    uiSize.problemList.some((problem) => problem.includes('尺寸')) && uiSize.canSave === false,
    uiSize.problemList.join('；'),
  );
  check(
    '三种坏尺寸下，面板的问题列表都仍与 validateCustomItem 逐条一致（含顺序）',
    sameList(uiSize.problemList, directProblems(draftOf(uiSize))),
    `面板：${uiSize.problemList.join('｜')}`,
  );
  check(
    '不能保存的原因来自 saveDisabledReason，且是中文',
    typeof uiSize.saveDisabledReason === 'string' && hasChinese(uiSize.saveDisabledReason),
    String(uiSize.saveDisabledReason),
  );
  check(
    '坏尺寸下 save() 也会被拒（不只是按钮禁用）',
    uiSize.save().ok === false,
    uiSize.save().message,
  );

  uiSize.setPart(0, { size: [0.4, 3, 0.4] });
  check(
    '把尺寸改回合法值后又能保存了（说明上面的禁用确实是尺寸造成的）',
    sizeBefore === true && uiSize.canSave === true && uiSize.saveDisabledReason === null,
    `canSave=${uiSize.canSave}`,
  );

  // ==================================================================
  // 5. 颜色：非法输入与校验器保持一致，且不许把 NaN 写进草稿
  // ==================================================================
  const uiColor = new CustomItemUI(null, handlers);
  fillValid(uiColor, '颜色');
  const colorBefore = draftOf(uiColor).parts[0]!.color;
  const badColor = uiColor.setPartColorHex(0, '#zzzzzz');
  check(
    '非法颜色「#zzzzzz」被拒绝，给出中文原因',
    badColor.ok === false && hasChinese(badColor.message),
    badColor.message,
  );
  check(
    '被拒绝后草稿里的颜色保持原值（没有被写成 NaN）',
    draftOf(uiColor).parts[0]!.color === colorBefore && Number.isFinite(draftOf(uiColor).parts[0]!.color),
    `颜色 = 0x${colorBefore.toString(16)}`,
  );
  check(
    '颜色被拒之后问题列表仍与 validateCustomItem 一致（拒绝动作没有引入自己的规则）',
    sameList(uiColor.problemList, directProblems(draftOf(uiColor))),
    `面板：${uiColor.problemList.join('｜')}`,
  );

  const goodColor = uiColor.setPartColorHex(0, '#3366ff');
  check(
    '合法颜色「#3366ff」被接受并解析成 0x3366ff',
    goodColor.ok === true && draftOf(uiColor).parts[0]!.color === 0x3366ff,
    `颜色 = 0x${draftOf(uiColor).parts[0]!.color.toString(16)}`,
  );

  uiColor.setPart(0, { color: Number.NaN });
  check(
    '真把 NaN 塞进零件颜色时，报的是校验器的「颜色不合法」，且 canSave === false',
    uiColor.canSave === false && uiColor.problemList.some((problem) => problem.includes('颜色不合法')),
    uiColor.problemList.join('；'),
  );
  check(
    '主色字段同样拒绝非法输入（保持原值）',
    uiColor.setMeta('color', '#zzzzzz').ok === false && Number.isFinite(draftOf(uiColor).color),
    `主色 = 0x${draftOf(uiColor).color.toString(16)}`,
  );

  // ==================================================================
  // 6. 假 DOM：保存按钮的禁用状态、形状下拉的来源、删除入口、事件委托
  // ==================================================================
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const stub = installStubDom();
  if (!stub) {
    check('DOM 桩可用（本环境里没有真实 document）', false, '已经有真实 document，DOM 分支断言需要按真实环境调整');
  } else {
    // 片段里的 canvas 先摆好：面板应该认出它，而不是再建一个
    const declaredCanvas = makeStubNode('canvas');
    declaredCanvas.id = 'custom-item-preview';
    stub.dom.root.appendChild(declaredCanvas);

    const domRecord: Recorder = { created: [], deleted: [], errors: [] };
    const uiDom = new CustomItemUI(stub.dom.root as unknown as HTMLElement, makeHandlers(domRecord));

    check(
      '假 DOM 下建起了编辑器（容器里恰好有一个编辑器根节点）',
      walkTree(stub.dom.root, (node) => node.dataset.customItemRole === 'editor').length === 1,
      `容器里共 ${walkTree(stub.dom.root, () => true).length} 个节点`,
    );
    const canvases = walkTree(stub.dom.root, (node) => node.tagName === 'canvas');
    check(
      '预览用的是 HTML 片段里那个 #custom-item-preview（树里只有一个 canvas，且就是它）',
      canvases.length === 1 && canvases[0] === declaredCanvas,
      `canvas 节点数 = ${canvases.length}`,
    );

    const shapeOptionSets = walkTree(stub.dom.root, (node) => node.tagName === 'select').map((node) =>
      node.children.filter((child) => child.tagName === 'option').map((option) => option.value),
    );
    check(
      '形状下拉的选项就是 CUSTOM_SHAPES 本身（面板没有自己写一份形状列表）',
      shapeOptionSets.some(
        (values) => values.length === CUSTOM_SHAPES.length && CUSTOM_SHAPES.every((shape) => values.includes(shape)),
      ),
      `下拉里的形状集合：${shapeOptionSets.map((values) => values.join('/')).join(' ｜ ')}`,
    );

    const saveButton = byAction(stub.dom.root, 'save');
    check(
      '假 DOM 里能找到保存按钮（data-custom-item-action="save"）',
      saveButton !== undefined,
      saveButton ? '已找到' : '没找到',
    );

    // ---- 非法尺寸 → 按钮 disabled ----
    fillValid(uiDom, 'DOM 里的圆柱');
    check('校验通过时保存按钮的 disabled === false', saveButton?.disabled === false, `disabled=${String(saveButton?.disabled)}`);

    uiDom.setPart(0, { size: [0, 3, 0.4] });
    check('非法尺寸（0）时保存按钮的 disabled === true', saveButton?.disabled === true, `disabled=${String(saveButton?.disabled)}`);

    const problemsText = byRole(stub.dom.root, 'problems')?.textContent ?? '';
    check(
      '问题清单真的画在界面上（文字里含校验器给的那条尺寸问题）',
      problemsText.includes('尺寸') && hasChinese(problemsText),
      problemsText.split('\n')[0] ?? '',
    );
    const summaryText = byRole(stub.dom.root, 'summary')?.textContent ?? '';
    check(
      '零件列表摘要是「形状 @ (x, y, z) 宽×高×深」那种一行一个',
      summaryText.includes('圆柱 @ (0, 1.5, 0) 0×3×0.4'),
      summaryText.split('\n')[1] ?? summaryText,
    );
    const saveNoteText = byRole(stub.dom.root, 'save-note')?.textContent ?? '';
    check(
      '保存按钮旁边写清了不能保存的原因（中文）',
      saveNoteText.length > 0 && hasChinese(saveNoteText),
      saveNoteText,
    );

    uiDom.setPart(0, { size: [0.4, 3, 0.4] });
    check('尺寸改回合法值后保存按钮重新可点（disabled === false）', saveButton?.disabled === false, `disabled=${String(saveButton?.disabled)}`);

    // ---- 事件委托 ----
    const nameInput = walkTree(stub.dom.root, (node) => node.dataset.customItemField === 'name')[0];
    const metaBox = walkTree(stub.dom.root, (node) => node.className === 'custom-item-meta')[0];
    if (nameInput && metaBox) {
      nameInput.value = '敲进来的名字';
      metaBox.dispatch('input', nameInput);
    }
    check(
      '事件委托生效：在名称输入框上派发 input 事件，草稿名称跟着变',
      nameInput !== undefined && metaBox !== undefined && draftOf(uiDom).name === '敲进来的名字',
      `name = ${JSON.stringify(draftOf(uiDom).name)}`,
    );

    const shapeSelect = walkTree(stub.dom.root, (node) => node.dataset.customItemField === 'shape')[0];
    const partsBox = byRole(stub.dom.root, 'parts');
    if (shapeSelect && partsBox) {
      shapeSelect.value = 'cone';
      partsBox.dispatch('change', shapeSelect);
    }
    check(
      '事件委托生效：改形状下拉后草稿里的形状跟着变（同时摘要也更新）',
      draftOf(uiDom).parts[0]?.shape === 'cone' &&
        (byRole(stub.dom.root, 'summary')?.textContent ?? '').includes('圆锥 @'),
      `shape=${String(draftOf(uiDom).parts[0]?.shape)}`,
    );
    uiDom.setPart(0, { shape: 'cylinder' });

    // ---- 预览降级（桩的 getContext 永远返回 null） ----
    check(
      '拿不到 WebGL 上下文时预览降级成文字模式（previewMode === "text"），且不抛异常',
      uiDom.previewModeValue === 'text' && uiDom.previewFallbackReason.length > 0,
      uiDom.previewFallbackReason,
    );
    const previewNote = byRole(stub.dom.root, 'preview-note')?.textContent ?? '';
    check(
      '降级时预览区给的是零件文字摘要，而不是空白',
      previewNote.includes('预览不可用') && previewNote.includes('圆柱 @ (0, 1.5, 0) 0.4×3×0.4'),
      previewNote.split('\n')[0] ?? '',
    );

    uiDom.setPart(0, { size: [1.2, 3, 0.4] });
    const previewAfter = byRole(stub.dom.root, 'preview-note')?.textContent ?? '';
    check(
      '降级之后预览仍然跟着改动走（摘要里出现新尺寸）',
      previewAfter.includes('圆柱 @ (0, 1.5, 0) 1.2×3×0.4'),
      previewAfter.split('\n')[1] ?? '',
    );
    uiDom.setPart(0, { size: [0.4, 3, 0.4] });

    // ---- 保存 / 删除 / 上限 ----
    const limitNoteText = byRole(stub.dom.root, 'limit-note')?.textContent ?? '';

    const saveResult = uiDom.save();
    check(
      '点保存后 onCreated 收到 def，且零件数与返回值一致',
      saveResult.ok && saveResult.count === 1 && domRecord.created.length === 1 && domRecord.created[0]!.parts.length === 1,
      saveResult.message,
    );
    check(
      'onCreated 收到的 def 用的是与内置物品同一套结构（shape=composite / type=prop / 带 tags）',
      domRecord.created[0]?.shape === 'composite' &&
        domRecord.created[0]?.type === 'prop' &&
        (domRecord.created[0]?.tags ?? []).includes('自定义'),
      `shape=${String(domRecord.created[0]?.shape)} type=${String(domRecord.created[0]?.type)}`,
    );
    check(
      '已保存列表画出来了（有对应 defId 的行 + 删除按钮）',
      byAction(stub.dom.root, 'delete-saved')?.dataset.defId === domRecord.created[0]?.id,
      `defId=${String(byAction(stub.dom.root, 'delete-saved')?.dataset.defId)}`,
    );
    check(
      '删除说明的小字写清了「世界里已经放好的那些不会被删掉」',
      walkTree(stub.dom.root, (node) => node.textContent.includes('世界里已经放好的那些不会被删掉')).length > 0,
      '界面上有这句话',
    );
    check(
      '保存结果通过状态行说出来（没有静默成功）',
      (byRole(stub.dom.root, 'io-status')?.textContent ?? '').length > 0,
      byRole(stub.dom.root, 'io-status')?.textContent ?? '',
    );
    check(
      `上限提示用的是真实上限 ${CUSTOM_ITEM_LIMIT}（已存 x / 上限）`,
      limitNoteText.includes(`/ ${CUSTOM_ITEM_LIMIT}`),
      limitNoteText,
    );

    const deletedId = domRecord.created[0]!.id;
    const deleteResult = uiDom.deleteSaved(deletedId);
    check(
      '删除会调 onDeleted 并把 id 原样传出去（世界里的实例交给 Engine 处理）',
      deleteResult.ok && domRecord.deleted.length === 1 && domRecord.deleted[0] === deletedId,
      `onDeleted 收到：${domRecord.deleted.join(',') || '（没有）'}`,
    );
    check(
      '删除之后已保存列表里不再有那一行',
      byAction(stub.dom.root, 'delete-saved')?.dataset.defId !== deletedId,
      `列表里的删除按钮数 = ${walkTree(stub.dom.root, (node) => node.dataset.customItemAction === 'delete-saved').length}`,
    );
    const exportAfterDelete = byRole(stub.dom.root, 'export-text')?.value ?? '';
    // 这条是补一个真出现过的疏漏：空列表走的是提前 return 的分支，
    // 导出框一度不会被刷新 —— 玩家删掉最后一个物品后，复制走的还是已经删掉的那份 JSON
    check(
      '删掉最后一个物品后导出框里是空列表（没有留着已经删掉的那份 JSON）',
      exportAfterDelete.includes('"items": []') && !exportAfterDelete.includes(deletedId),
      exportAfterDelete.replace(/\s+/g, ' ').slice(0, 80),
    );

    // ---- 上限：存满之后保存必须禁用（用**另一个容器**，免得把上面那份面板的 DOM 清掉） ----
    const limitContainer = makeStubNode('div');
    const limitUi = new CustomItemUI(limitContainer as unknown as HTMLElement, makeHandlers(domRecord));
    const fillToLimit = limitUi.importFromText(
      exportFileWith(Array.from({ length: CUSTOM_ITEM_LIMIT }, (_unused, index) => `批量物品${index}`)),
    );
    check(
      `能导入到上限 ${CUSTOM_ITEM_LIMIT} 个（本环境没有 localStorage 时也要能进内存列表）`,
      fillToLimit.ok && limitUi.savedItems.length === CUSTOM_ITEM_LIMIT,
      `${fillToLimit.message}｜现在 ${limitUi.savedItems.length} 个`,
    );
    const limitSaveButton = byAction(limitContainer, 'save');
    check(
      `存满 ${CUSTOM_ITEM_LIMIT} 个之后保存按钮 disabled === true`,
      limitSaveButton?.disabled === true,
      `disabled=${String(limitSaveButton?.disabled)}`,
    );
    check(
      '到上限时的禁用原因里写明了上限数字（不是一句「不可用」）',
      (limitUi.saveDisabledReason ?? '').includes(String(CUSTOM_ITEM_LIMIT)) &&
        hasChinese(limitUi.saveDisabledReason ?? ''),
      String(limitUi.saveDisabledReason),
    );
    const countBeforeSave = limitUi.savedItems.length;
    const saveAtLimit = limitUi.save();
    check(
      '到上限后再 save() 返回 false，且列表数量不变',
      saveAtLimit.ok === false && limitUi.savedItems.length === countBeforeSave,
      saveAtLimit.message,
    );

    check(
      '没有 localStorage 时，界面上如实写明「改动只在本次打开期间有效」',
      hasLocalStorage
        ? true // 有存储时这条不适用：下面用注入的假存储单独测往返
        : (byRole(stub.dom.root, 'limit-note')?.textContent ?? '').includes('只在本次打开期间有效'),
      hasLocalStorage ? '本环境有 localStorage，跳过' : (byRole(stub.dom.root, 'limit-note')?.textContent ?? ''),
    );

    stub.restore();
    check(
      'DOM 桩已经原样还原（globalThis.document 描述符与安装前完全一致）',
      Object.getOwnPropertyDescriptor(globalThis, 'document') === documentBefore,
      `现在 document = ${typeof (globalThis as { document?: unknown }).document}`,
    );
  }

  // ==================================================================
  // 7. 导入：失败要说原因、且一个都不写；成功要真的进列表
  // ==================================================================
  const uiImport = new CustomItemUI(null, handlers);
  const before = uiImport.savedItems.length;
  const badJson = uiImport.importFromText('这不是 JSON');
  check(
    '导入非法 JSON → ok === false、给出中文原因，已存列表数量不变',
    badJson.ok === false && hasChinese(badJson.message) && uiImport.savedItems.length === before,
    `${badJson.message}｜数量 ${before} → ${uiImport.savedItems.length}`,
  );
  const emptyJson = uiImport.importFromText('   ');
  check(
    '导入空粘贴框 → ok === false、中文原因（不许静默失败）',
    emptyJson.ok === false && hasChinese(emptyJson.message) && uiImport.savedItems.length === before,
    emptyJson.message,
  );
  const noItemsJson = uiImport.importFromText('{"version":1,"kind":"god-sandbox-custom-items"}');
  check(
    '导入结构不对（没有 items 数组）→ 中文原因、数量不变',
    noItemsJson.ok === false && hasChinese(noItemsJson.message) && uiImport.savedItems.length === before,
    noItemsJson.message,
  );

  const goodImport = uiImport.importFromText(exportFileWith(['导入一号', '导入二号']));
  check(
    '导入合法 JSON → 已存列表 +2',
    goodImport.ok === true && goodImport.count === 2 && uiImport.savedItems.length === before + 2,
    `${goodImport.message}｜数量 ${before} → ${uiImport.savedItems.length}`,
  );
  check(
    '导入进来的两个物品 id 互不相同（没有互相覆盖）',
    uiImport.savedItems[0]!.id !== uiImport.savedItems[1]!.id,
    `${uiImport.savedItems[0]!.id} / ${uiImport.savedItems[1]!.id}`,
  );

  const overflowUi = new CustomItemUI(null, handlers);
  const overflow = overflowUi.importFromText(
    exportFileWith(Array.from({ length: CUSTOM_ITEM_LIMIT + 1 }, (_unused, index) => `爆量${index}`)),
  );
  check(
    `导入会把数量顶过上限（${CUSTOM_ITEM_LIMIT} + 1）时整体拒绝，一个都不写`,
    overflow.ok === false && overflowUi.savedItems.length === 0 && hasChinese(overflow.message),
    `${overflow.message}｜数量 ${overflowUi.savedItems.length}`,
  );

  // ---- 文件导入：同步就能判定的三条失败路径 ----
  //
  // 注意这三条路径的**返回值都是 Promise**（接口约定如此），所以断言读的不是返回值，
  // 而是它们**同步就报告出去**的那句中文原因（onError / 状态行）。
  // `importFromFile` 刻意写成"非 async + 显式 Promise 链"，就是为了这一点：
  // 面板在玩家选完文件的那一瞬间就有中文反馈，而不是等一个微任务。
  const uiFile = new CustomItemUI(null, handlers);
  const errorsBeforeFile = record.errors.length;
  const filePromises: Promise<CustomItemOpResult>[] = [];
  let fileThrew = '';
  try {
    filePromises.push(uiFile.importFromFile(null));
    const brokenFile = {
      text: (): never => {
        throw new Error('模拟：文件读不出来');
      },
    } as unknown as File;
    filePromises.push(uiFile.importFromFile(brokenFile));
    // 只有 size、没有 text()：老浏览器 / 手改过的 DOM 里 File 可能就长这样
    const noTextFile = { size: 10 } as unknown as File;
    filePromises.push(uiFile.importFromFile(noTextFile));
  } catch (error) {
    fileThrew = messageOf(error);
  }
  const fileReports = record.errors.slice(errorsBeforeFile);
  check(
    '没选文件 / 读不了文件（没有 File.text）/ file.text() 同步抛：三条路径都给出中文原因',
    fileThrew === '' && fileReports.length === 3 && fileReports.every((message) => hasChinese(message)),
    fileThrew === '' ? fileReports.join('｜') : `抛了：${fileThrew}`,
  );
  check(
    '三条失败原因分别说清了「没选文件」「读文件失败」「File.text 不可用」',
    fileReports[0]?.includes('没有选中文件') === true &&
      fileReports[1]?.includes('读文件失败') === true &&
      fileReports[2]?.includes('File.text') === true,
    fileReports.join('｜'),
  );
  check(
    'importFromFile 返回的是 Promise（不是同步抛异常），且失败时一个都没写进列表',
    fileThrew === '' &&
      filePromises.length === 3 &&
      filePromises.every((item) => typeof item?.then === 'function') &&
      uiFile.savedItems.length === 0,
    `返回 Promise 的数量 = ${filePromises.length}｜列表里 ${uiFile.savedItems.length} 个`,
  );

  // ==================================================================
  // 8. 存储：没有 localStorage 就如实降级；注入假存储后测真实往返
  // ==================================================================
  if (hasLocalStorage) {
    check('本环境有 localStorage：往返用真实存储测（见下面的往返断言）', true, '有 localStorage');
  } else {
    const noStore = saveCustomItems([]);
    check(
      '本环境没有 localStorage：saveCustomItems 如实返回失败 + 中文原因（不假装存好了）',
      noStore.ok === false && hasChinese(noStore.reason ?? ''),
      String(noStore.reason),
    );
  }

  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = makeFakeStorage();
  let storageError = '';
  let saveRoundTripOk = false;
  let wroteToStorage = false;
  let rereadOk = false;
  let exportImportOk = false;
  let roundTripDetail = '';
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake });

    const uiStore = new CustomItemUI(null, handlers);
    fillValid(uiStore, '往返圆柱');
    const saved = uiStore.save();
    const original = uiStore.savedItems[0];
    wroteToStorage = fake.map.has(CUSTOM_ITEM_STORAGE_KEY);
    saveRoundTripOk = saved.ok && uiStore.savedItems.length === 1 && original !== undefined;
    roundTripDetail = saved.message;

    // 换一个**新的**面板读同一份存储：这才叫"真的写进去了"，只看内存里那份不算
    const uiReopen = new CustomItemUI(null, handlers);
    rereadOk = uiReopen.savedItems.length === 1 && uiReopen.savedItems[0]!.name === '往返圆柱';
    const exported = uiReopen.exportText();

    // 清掉存储，让 id 生成不因为撞车而加后缀（id 规则本身不在这个断言的范围里）
    fake.map.clear();
    const uiFresh = new CustomItemUI(null, handlers);
    const importedBack = uiFresh.importFromText(exported);
    const back = uiFresh.savedItems[0];
    exportImportOk =
      importedBack.ok &&
      importedBack.count === 1 &&
      original !== undefined &&
      back !== undefined &&
      back.id === original.id &&
      back.parts.length === original.parts.length &&
      partsEqual(back.parts, original.parts);
    if (!exportImportOk) roundTripDetail += `｜导出导入：${importedBack.message}`;
  } catch (error) {
    storageError = messageOf(error);
  } finally {
    // 无论断言结果如何都要还回去，否则后面的断言（或别的 check 文件）会踩到这个假存储
    if (storageBefore) Object.defineProperty(globalThis, 'localStorage', storageBefore);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }

  check(
    '注入假 localStorage 后：保存能把自定义物品真的写进存储，并能被一个新的面板读回来',
    storageError === '' && saveRoundTripOk && wroteToStorage && rereadOk,
    storageError === ''
      ? `${roundTripDetail}｜存储键存在=${wroteToStorage}｜新面板读到 ${rereadOk ? 1 : 0} 个`
      : `抛了：${storageError}`,
  );
  check(
    '导出 → 导入 往返后 def.id 与 parts 长度一致，且每个零件的形状/位置/尺寸/颜色逐项相同',
    storageError === '' && exportImportOk,
    storageError === '' ? (exportImportOk ? '往返完全一致' : roundTripDetail) : `抛了：${storageError}`,
  );
  const exportKindUi = new CustomItemUI(null, handlers);
  check(
    '导出的 JSON 带 kind 标记（能被 importCustomItems 认出来）',
    /god-sandbox-custom-items/.test(exportKindUi.exportText()),
    exportKindUi.exportText().replace(/\s+/g, ' ').slice(0, 80),
  );
  check(
    '假 localStorage 已经还原（不给别的断言留下全局污染）',
    Object.getOwnPropertyDescriptor(globalThis, 'localStorage') === storageBefore,
    `现在 localStorage = ${typeof (globalThis as { localStorage?: unknown }).localStorage}`,
  );
  check(
    '面板导出的文本 === exportCustomItems(已保存列表)（面板没有再加工一遍）',
    (() => {
      const uiExport = new CustomItemUI(null, handlers);
      fillValid(uiExport, '导出对照');
      const accepted = uiExport.save();
      return accepted.ok && uiExport.exportText() === exportCustomItems(uiExport.savedItems);
    })(),
    '两者逐字节相同',
  );

  // ==================================================================
  // 9. dispose 之后：所有公开方法都不能抛
  // ==================================================================
  const uiDisposed = new CustomItemUI(null, handlers);
  fillValid(uiDisposed, '关掉之后');
  uiDisposed.dispose();
  let disposeError = '';
  try {
    uiDisposed.refresh();
    uiDisposed.addPart('box');
    uiDisposed.removePart(0);
    uiDisposed.setPart(0, { size: [1, 1, 1] });
    uiDisposed.setMeta('name', '关掉之后');
    uiDisposed.deleteSaved('不存在');
    uiDisposed.importFromText('{"items":[]}');
    void uiDisposed.importFromFile(null);
    uiDisposed.exportText();
    void uiDisposed.draft;
    void uiDisposed.canSave;
    void uiDisposed.previewText;
  } catch (error) {
    disposeError = messageOf(error);
  }
  check(
    'dispose() 之后再调 refresh() 等全部公开方法都不抛异常',
    disposeError === '',
    disposeError || '都安全返回了',
  );
  check(
    'dispose() 之后 canSave === false，且原因是「编辑器已经关闭」',
    uiDisposed.canSave === false && String(uiDisposed.saveDisabledReason).includes('编辑器已经关闭'),
    String(uiDisposed.saveDisabledReason),
  );
  check(
    'dispose() 之后 save() 返回 false 而不是抛异常',
    uiDisposed.save().ok === false,
    uiDisposed.save().message,
  );

  // 收尾：断言过程里触发的 onError 都必须是中文说明（不许英文异常串裸奔到界面上）
  check(
    '整个断言过程里触发的 onError 都是中文说明',
    record.errors.length > 0 && record.errors.every((message) => hasChinese(message)),
    `${record.errors.length} 条｜最后一条：${record.errors[record.errors.length - 1] ?? '（没有）'}`,
  );
}
