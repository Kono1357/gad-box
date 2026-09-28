/**
 * 帮助中心（M5 第 3 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 它解决的是"知道有功能，但不知道按哪个键"
 * ────────────────────────────────────────────────────────────
 * 项目里已经有一张 `ui/ShortcutHelp.ts` 的**快捷键速查表**（按 ? 弹出）。
 * 那个面板回答的是"这个键干什么"，本面板回答的是"我想干某件事，该怎么做" ——
 * 两类问题的入口不同：玩家看得懂 W A S D 表，却不一定能从中推出
 * "想让水冻住当闸门"要按 4 再点「冻结」。
 * 所以本文件的每一条答案都**具体到操作**（按哪个键、点哪个面板的哪个按钮），
 * 不写"可以通过流体系统实现"这种正确但没用的话。
 * `related` 里放的是相关快捷键/工具名：调用方点它就能跳到对应面板（见 `onOpenExample` 之外的扩展点）。
 *
 * ────────────────────────────────────────────────────────────
 * 搜索：中文包含匹配 + 分词，不做"聪明"的东西
 * ────────────────────────────────────────────────────────────
 * 中文没有词边界，所以这里**不引入分词库**（会新增依赖，而且对两三个字的查询没帮助）。
 * 做法是：把查询按空白/标点切成若干片段，**每一段都要在"问题 + 答案 + 分类 + 关联词"
 * 里出现**（AND 语义），命中位置越靠前排序越前。这样：
 * - 搜「水」→ 命中所有答案或问题里有"水"的条目；
 * - 搜「水 冻结」→ 两个词都得出现，直接把"水压与闸门"顶到最前；
 * - 搜「zzz」→ 返回空数组（**不抛异常、也不返回全部** —— 后者会让玩家以为搜索没生效）。
 * 空查询返回全部（按分类分组的原始顺序），这是"还没想好搜什么"时的默认视图。
 *
 * ────────────────────────────────────────────────────────────
 * DOM 约定：容器为 null 时一切照常工作
 * ────────────────────────────────────────────────────────────
 * 构造函数收的是 `HTMLElement | null`：传 null（Node 断言、或者这一版页面还没插容器）
 * 时，`search` / `setCategory` 照样能用，只是画不出来。
 * 所有节点都用 `container.ownerDocument` 建，**不碰全局 `document`** ——
 * 这样即使页面里有多份文档（iframe / 测试夹具），也不会把节点建到别人的文档里。
 * 样式全部内联（`src/style.css` 在并发编辑中，不能改）。
 */

import { EXAMPLE_SCENES, describeExample, type ExampleScene } from '../tutorial/Examples';

// ============================================================================
// 分类
// ============================================================================

/** 帮助分类（顺序 = 面板上的显示顺序） */
export const HELP_CATEGORIES: readonly string[] = [
  '基础',
  '地形',
  '建筑',
  '物理',
  '流体',
  '存档',
  '快捷键',
];

export interface HelpTopic {
  id: string;
  category: string;
  question: string;
  answer: string;
  /** 相关快捷键 / 工具 id，点了能跳到对应面板 */
  related?: readonly string[];
}

/**
 * 35 条帮助（需求要求 ≥25，实际条数在断言里核对）。
 *
 * 每一条的答案都写过一遍"照着做能不能成"：给出的按键与面板名都是真实存在的
 * （`1`~`5` 切工具见 `Engine.handleKeyDown` 的 `Digit1..Digit5`；
 * 面板 id 见 `index.html`；快捷键见 `ui/ShortcutHelp.ts`；示例 id 见 `tutorial/Examples.ts`）。
 * 答案里提到示例的地方一律用**真实存在的示例 id**，`related` 里也写 id，
 * 这样"打开示例"按钮不会打开一个不存在的场景。
 */
export const HELP_TOPICS: readonly HelpTopic[] = [
  // ---------------------------------------------------------------- 基础
  {
    id: 'basic-move-camera',
    category: '基础',
    question: '怎么转动 / 拉近视角？',
    answer:
      '按住鼠标中键拖动转视角，滚轮拉近拉远，按住右键拖动平移。键盘上 W A S D 水平移动、' +
      'Q / E 升降、Shift 加速，按 F 复位相机。手机上是双指拖动平移、双指捏合缩放。',
    related: ['中键拖拽', '滚轮', 'F'],
  },
  {
    id: 'basic-tools',
    category: '基础',
    question: '几个工具怎么切换？',
    answer:
      '按 1 地形笔刷、2 建筑放置、3 选择与拿起、4 流体、5 沙土；也可以点顶部工具栏上对应的按钮。' +
      '按 Tab 在「编辑 / 观察」两种模式之间切换 —— 观察模式下左键用来转视角，不会误改地形。',
    related: ['1', '2', '3', '4', '5', 'Tab'],
  },
  {
    id: 'basic-undo',
    category: '基础',
    question: '改错了怎么撤销？',
    answer:
      '按 Ctrl+Z 撤销、Ctrl+Y（或 Ctrl+Shift+Z）重做。笔刷的**一次拖动**算一步，' +
      '所以倒回去不会一格一格地退。左侧「历史」面板里能看到完整的操作清单，点某一条可以直接跳回那一步。',
    related: ['Ctrl+Z', 'Ctrl+Y'],
  },
  {
    id: 'basic-pickup',
    category: '基础',
    question: '怎么拿起一个已经放好的物体？',
    answer:
      '按 3 切到选择工具，左键点一下物体选中它，再按空格拿起（空格键＝拿起/放下）。' +
      '拿起时物体会跟着光标走，再点一次左键就放到新位置。想拿起一整片就按住左键框选。',
    related: ['3', '空格'],
  },
  {
    id: 'basic-delete',
    category: '基础',
    question: '怎么删除物体？',
    answer: '选中之后按 Delete 键，或者点「建筑」面板里的删除按钮。多选（Ctrl+左键）之后一次删掉一片。',
    related: ['Delete', 'Ctrl+左键'],
  },
  {
    id: 'basic-physics-play',
    category: '基础',
    question: '放好的东西为什么不动？',
    answer:
      '因为模拟默认在「编辑」状态：物体被钉住，这样你才能摆得准。点顶部工具栏的 ⏸/▶（或看「时间控制」那一组按钮）' +
      '恢复模拟，东西才会掉下来、被推动。⏭ 是单步前进 1/60 秒，用来一帧一帧看碰撞。',
    related: ['暂停 / 播放', '单步前进'],
  },
  {
    id: 'basic-tutorial',
    category: '基础',
    question: '有教程吗？从哪一关开始？',
    answer:
      '有，一共 15 关：先做「会开的门」「四轮小车」「吊桥」认识放置与关节，再进「重力与掉落」等物理关，' +
      '最后玩流体与沙土（「水流向低处」「沙崩」「泥流」）。点右上角「🎓 教学」打开清单，' +
      '面板里按分类排列，每一关都写着"要干什么"和"什么算过关"。',
    related: ['J'],
  },

  // ---------------------------------------------------------------- 地形
  {
    id: 'terrain-basic',
    category: '地形',
    question: '怎么把地面抬高或挖下去？',
    answer:
      '按 1 切到地形笔刷，按住左键在地面上拖就是抬升；按住 Shift 再拖是下沉（挖洞）。' +
      '笔刷落点跟着光标走，屏幕上会显示一个半透明的高亮范围。',
    related: ['1', 'Shift'],
  },
  {
    id: 'terrain-radius',
    category: '地形',
    question: '怎么把笔刷调大调小？',
    answer:
      '按住 Alt 滚轮调半径、Ctrl+滚轮调强度。左侧「🖌 笔刷」面板里也有半径与强度的滑块，' +
      '数值会实时显示。半径范围是 0.5 ~ 16 米，强度 0.1 ~ 1.0。',
    related: ['Alt + 滚轮', 'Ctrl + 滚轮'],
  },
  {
    id: 'terrain-modes',
    category: '地形',
    question: '除了抬升下沉，还有别的笔刷吗？',
    answer:
      '有 12 种：按 1~9、0、-、= 直接切。常用的几种是「抬升」「下沉」「挖洞」「填实」「平滑」' +
      '「噪声」「随机」「上色」。左侧面板把每种模式的说明都写了，鼠标悬停还有提示。',
    related: ['1~9 0 - ='],
  },
  {
    id: 'terrain-water',
    category: '地形',
    question: '地形里的水（湖/海）能动吗？',
    answer:
      '那是体素水（一格一格的水），默认开启流动：挖开堤岸它就会往低处流。' +
      '右侧「沙土」「流体」面板里的粒子水是另一套系统 —— 那是可以倒在任何地方的粒子，' +
      '两者互不干扰。想倒粒子水见「流体」一节。',
    related: ['4'],
  },
  {
    id: 'terrain-flat',
    category: '地形',
    question: '想搭个大平地，一点点刷太慢了',
    answer:
      '用「平整 / 平滑」笔刷，把半径调到 16 米，来回拖几遍就平了；或者按 M 打开主菜单' +
      '挑一张参考地图（「平原村庄」那个地形起伏本来就很小）。也可以直接在建筑面板放一块' +
      '「地基」（6×6 米）当工作台面。',
    related: ['M', '1'],
  },

  // ---------------------------------------------------------------- 建筑
  {
    id: 'build-place',
    category: '建筑',
    question: '怎么放一个建筑？',
    answer:
      '按 2 切到建筑工具，在左侧「🏠 建筑」面板里选一个模型（顶部有搜索框，也可以按分类翻页），' +
      '然后把光标移到地面上 —— 会出现一个跟随光标的高亮框，点左键确认放置。',
    related: ['2', 'Enter'],
  },
  {
    id: 'build-rotate',
    category: '建筑',
    question: '怎么旋转要放的东西？',
    answer:
      '放置前按 Ctrl+滚轮微调旋转角，或者用面板上的旋转步长按钮按 15° 一档转。' +
      '⚠ 物体**只能绕竖直轴旋转**：模型库里没有"斜着放"的选项，坡道这类构件自带倾角。',
    related: ['Ctrl + 滚轮'],
  },
  {
    id: 'build-snap',
    category: '建筑',
    question: '放东西总是对不齐怎么办？',
    answer:
      '按 G 开关吸附点对齐，光标会吸附到附近物体的边缘/顶面上；按 [ 或 ] 在多个候选吸附点之间切换。' +
      '放置面板上还能设置吸附步长（比如 0.5 米），让位置落在整数格上。',
    related: ['G', '[ / ]'],
  },
  {
    id: 'build-combo',
    category: '建筑',
    question: '有没有现成的"装置"可以一键放下？',
    answer:
      '有，点顶部「组合」按钮打开组合库：会开的门、四轮小车、吊桥、齿轮传动这些装置都是' +
      '连好关节的，放下去就能动。想存自己的常用结构，用「预制件」面板保存选中物体。',
    related: [],
  },
  {
    id: 'build-custom',
    category: '建筑',
    question: '能自己捏一个新的模型吗？',
    answer:
      '能，打开「自定义物品」面板可以拼一个方块组合并命名，它会和内置模型一样出现在建筑面板里' +
      '（存在浏览器本地，导出 JSON 之后能在别的设备导入）。',
    related: [],
  },

  // ---------------------------------------------------------------- 物理
  {
    id: 'physics-gravity',
    category: '物理',
    question: '怎么改重力？比如做成月球？',
    answer:
      '打开「⚙️ 物理」面板，在重力预设里选地球 / 月球 / 火星 / 木星 / 零重力。' +
      '切到月球后同一个箱子会飘很久才落地，零重力下所有东西都浮着不动 —— 这是最快的"换一套规则"演示。',
    related: [],
  },
  {
    id: 'physics-material',
    category: '物理',
    question: '想让地面变得很滑（或者很弹）怎么做？',
    answer:
      '选中物体，在「物理」面板的材质里给它换成「冰」（摩擦低）或「橡胶」（恢复系数高）。' +
      '逐个换太慢时可以在物理面板里改默认材质，之后放下去的新物体都用它。' +
      '「斜坡滚球」示例就是三条不同材质的坡道，可以直接对比。',
    related: [],
  },
  {
    id: 'physics-joint',
    category: '物理',
    question: '门怎么才能绕着门轴转？',
    answer:
      '选中门和门框，打开「关节」面板，选「旋转关节」，轴取竖直方向，锚点放在合页那一侧，' +
      '点创建。之后按播放，用手推门它就会绕轴转开。要点是**锚点必须落在门框上**，' +
      '锚点放偏了门会直接弹飞。「会开的门」关卡就是练这个。',
    related: [],
  },
  {
    id: 'physics-rope',
    category: '物理',
    question: '吊桥 / 吊灯那种"只能用绳子吊住"怎么做？',
    answer:
      '关节面板里选「绳索关节」，锚点放在梁或柱顶，长度填绳子长度。绳索**只能拉不能推**，' +
      '所以桥面会先坠下去、坠到绳子拉直才被吊住 —— 「吊桥」示例可以一键加载对照着看。',
    related: [],
  },
  {
    id: 'physics-motor',
    category: '物理',
    question: '怎么让轮子 / 齿轮自己转起来？',
    answer:
      '选中关节，在关节面板里勾选「电机」，填目标速度（rad/s）和最大出力，点「启动」就转。' +
      '齿轮传动时注意：相邻齿轮的转向是相反的，所以给奇数号齿轮加正速度、偶数号加负速度。',
    related: [],
  },
  {
    id: 'physics-collapse',
    category: '物理',
    question: '怎么知道哪个结构不稳、快塌了？',
    answer:
      '打开「支撑」面板的着色开关：偏红偏亮的物体就是支撑不足的。再点面板里的「检查支撑」按钮' +
      '跑一次检查，悬挑超过 4 米的构件会被单独列出来（面板上会写"允许的最大悬挑 4 米"）。' +
      '「积木塔」示例可以拿来练手 —— 抽掉一根石柱再看一次支撑报告。',
    related: ['btn-check-support'],
  },

  // ---------------------------------------------------------------- 流体
  {
    id: 'fluid-pour',
    category: '流体',
    question: '怎么倒水？',
    answer:
      '按 4 切到流体工具，在「💧 流体」面板里选「泼水」，然后按住左键往下倒 —— 按住不放会持续出水。' +
      '想一次加一大片就用「加水」，想抽走就用「抽水」/「减水」。粒子数会实时显示在面板顶部（有上限）。',
    related: ['4'],
  },
  {
    id: 'fluid-freeze',
    category: '流体',
    question: '怎么把水冻住当墙 / 当闸门？',
    answer:
      '按 4 选「冻结」，对着有水的地方点一下，那一块水就冻成静止的固体，旁边的水会被它挡住。' +
      '想放开就选「解冻」点回去。「水压与闸门」那一关就是练这个；「水池与船」示例可以拿来试围堤。',
    related: ['4'],
  },
  {
    id: 'fluid-swim',
    category: '流体',
    question: '东西掉进水里会浮起来吗？',
    answer:
      '会，浮不浮取决于"它排开的水有多重"：空心的小船会浮，实心的混凝土地基（47520 公斤）会沉底。' +
      '想让某个东西浮起来，把它换成一个更轻的模型，或者把它做小一点。' +
      '「水池与船」示例里船和地基就摆在一起，可以直接对比。',
    related: [],
  },
  {
    id: 'fluid-flood',
    category: '流体',
    question: '想做个"洪水冲建筑"的效果',
    answer:
      '把「加水」按住不放，水会一层层涨起来，箱子、门板这类动态物体会被冲走。' +
      '水量大的时候流体步会很明显地吃帧（面板上有耗时），先把画面质量调低一档再灌水。' +
      '「洪水街道」示例已经摆好了街道与箱子，直接加载就能灌。',
    related: [],
  },
  {
    id: 'fluid-performance',
    category: '流体',
    question: '水一多就卡，怎么办？',
    answer:
      '看「💧 流体」面板上的粒子数与单帧耗时：桌面上限 20000、手机 3000，' +
      '超过上限会拒绝生成新粒子。卡的时候先把质量档降一档（会减少求解迭代与邻居数），' +
      '或者用「抽水」把不必要的水抽掉。岩浆/蜂蜜这类预设本身黏性更高、也更吃性能。',
    related: [],
  },

  // ---------------------------------------------------------------- 存档
  {
    id: 'save-basic',
    category: '存档',
    question: '怎么保存？下次打开还在吗？',
    answer:
      '按 Ctrl+S 保存到浏览器（工具栏的 💾 是同一个动作），下次打开这个页面会自动读回来。' +
      '默认还有每 30 秒的自动保存。注意浏览器存档是**按浏览器算的**：换浏览器、清缓存就没了。',
    related: ['Ctrl+S'],
  },
  {
    id: 'save-export',
    category: '存档',
    question: '怎么把世界导出来给别的设备用？',
    answer:
      '按 Ctrl+E 导出 JSON 文件（工具栏 ⬇），在另一台设备上按 Ctrl+O 或点 ⬆ 选那个文件导入。' +
      '导出的是**可读的 JSON**：地形改动、建筑、关节、流体粒子都在里面，出问题可以自己打开看。',
    related: ['Ctrl+E', 'Ctrl+O'],
  },
  {
    id: 'save-blueprint',
    category: '存档',
    question: '只想存我搭的那座桥，不想存整个地图',
    answer:
      '框选那座桥，用「预制件」面板保存成预制件（存在浏览器里），或者用「蓝图导出」按钮存成一个单独的 JSON。' +
      '蓝图只装选中的物体和它们之间的关节，换一张地图也能贴上去。',
    related: [],
  },
  {
    id: 'save-snapshot',
    category: '存档',
    question: '想回到几秒前那个瞬间',
    answer:
      '用「快照」（工具栏 📸）存一个关键帧，之后可以回到它；按 R 回溯一帧、Shift+R 前进一帧，' +
      '适合一帧一帧看碰撞到底发生了什么。注意快照占内存，存太多会让页面变慢。',
    related: ['R', 'Shift+R'],
  },

  // ---------------------------------------------------------------- 快捷键
  {
    id: 'keys-undo-redo',
    category: '快捷键',
    question: '撤销 / 重做的快捷键是什么？',
    answer: 'Ctrl+Z 撤销，Ctrl+Y 或 Ctrl+Shift+Z 重做。工具栏上也有 ↶ ↷ 两个按钮。',
    related: ['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z'],
  },
  {
    id: 'keys-list',
    category: '快捷键',
    question: '完整的快捷键表在哪？',
    answer:
      '按 F1，或者按住 Shift 再按 / （也就是打出 ?）打开快捷键速查表，按 Esc 收起。' +
      '表里分 8 组：文件与历史 / 相机 / 模式与工具 / 笔刷 / 建议与吸附 / 选择与微调 / 分组与蓝图 / 物理与调试，' +
      '每一条都是真实可用的键。',
    related: ['F1', '?'],
  },
  {
    id: 'keys-time',
    category: '快捷键',
    question: '时间控制（慢放 / 单步）的键是哪些？',
    answer:
      '时间控制没有单键，用顶部工具栏中间那一组按钮：⏸ 暂停/播放、⏭ 单步 1/60 秒，' +
      '以及 ¼× / ½× / 1× / 2× / 4× 变速，看碰撞细节时用 ¼× 最方便。' +
      '⏪ 是回溯一帧，对应键盘的 R（Shift+R 是前进一帧）。',
    related: ['R', 'Shift+R'],
  },
];

// ============================================================================
// 搜索
// ============================================================================

/**
 * 把查询切成片段。
 *
 * 全角空格也当分隔符（中文输入法下很容易打出全角空格，不处理的话
 * 搜「水　冻结」会匹配不到任何东西，而玩家只会觉得"搜索坏了"）。大小写统一成小写。
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\u3000,，、;；:：/|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** 一条记录的"可搜索文本"（问题 + 答案 + 分类 + 关联词） */
function haystackOf(topic: HelpTopic): string {
  return `${topic.question}\n${topic.answer}\n${topic.category}\n${(topic.related ?? []).join(' ')}`.toLowerCase();
}

/** 命中的分数：越小越靠前（问题里命中 > 答案里命中；位置越靠前越好） */
function score(topic: HelpTopic, tokens: readonly string[]): number {
  const question = topic.question.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    const inQuestion = question.indexOf(token);
    if (inQuestion >= 0) {
      total += inQuestion;
      continue;
    }
    const inHaystack = haystackOf(topic).indexOf(token);
    total += 1000 + Math.max(0, inHaystack);
  }
  return total;
}

/** 全部条目（面板渲染折叠列表用；顺序就是上面的书写顺序） */
export function allHelpTopics(): readonly HelpTopic[] {
  return HELP_TOPICS;
}

/** 按 id 取一条帮助 */
export function getHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}

/**
 * 纯搜索函数（不依赖类实例，Node 里可以直接断言）。
 *
 * - 空查询（或只有空白）→ 返回全部；
 * - 多个片段 → **每个片段都要命中**（AND）；只要有一个命中不了就返回空数组；
 * - 结果按命中位置排序（问题里命中优先、越靠前越优先）。
 */
export function searchHelpTopics(query: string): readonly HelpTopic[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return HELP_TOPICS;
  const hits = HELP_TOPICS.filter((topic) => {
    const haystack = haystackOf(topic);
    return tokens.every((token) => haystack.includes(token));
  });
  return [...hits].sort((a, b) => score(a, tokens) - score(b, tokens));
}

// ============================================================================
// 面板
// ============================================================================

/** 面板用的内联样式常量（`src/style.css` 在并发编辑中，所以全部内联，和 HintBanner 同一做法） */
const STYLE_CARD: Record<string, string> = {
  border: '1px solid #2b3640',
  borderRadius: '6px',
  background: 'rgba(20, 26, 32, 0.92)',
  color: '#d8e2ea',
  padding: '8px 10px',
  margin: '0 0 6px',
};
const STYLE_BUTTON: Record<string, string> = {
  minHeight: '44px',
  padding: '0 10px',
  borderRadius: '6px',
  border: '1px solid #2b3640',
  background: 'rgba(30, 38, 46, 0.95)',
  color: '#d8e2ea',
  cursor: 'pointer',
  font: 'inherit',
};

function style(el: HTMLElement, patch: Record<string, string>): void {
  Object.assign(el.style, patch);
}

export interface HelpCenterHandlers {
  /** 点了某一条帮助里的「打开示例」（参数是真实存在的示例 id） */
  onOpenExample?: (id: string) => void;
}

/**
 * 帮助中心面板。
 *
 * 它**只操作自己建的节点**：不会去 `document.getElementById` 找别的东西，
 * 也不会改 `src/style.css`（那个文件不归本模块管）。
 * 容器为 null 时全部渲染方法是空操作，但状态（当前分类 / 上一次查询）照常更新。
 */
export class HelpCenter {
  private readonly handlers: HelpCenterHandlers;
  private readonly doc: Document | null;
  private readonly root: HTMLElement | null;
  private readonly categoryBar: HTMLElement | null;
  private readonly searchInput: HTMLInputElement | null;
  private readonly statusLine: HTMLElement | null;
  private readonly list: HTMLElement | null;
  /** 当前分类（null = 全部） */
  private category: string | null = null;
  /** 当前查询（保留原文，`search()` 里用） */
  private query = '';
  /** 已经展开的条目 id（重建 DOM 时要还原展开状态，否则每敲一个字就全折叠回去） */
  private readonly expanded = new Set<string>();
  private disposed = false;

  constructor(container: HTMLElement | null, handlers: HelpCenterHandlers = {}) {
    this.handlers = handlers;
    // 用容器自己的 document，而不是全局 document：多文档场景下不会建错地方
    this.doc = container ? container.ownerDocument : null;
    this.root = container;

    if (!container || !this.doc) {
      // 没有容器：所有 DOM 引用都是 null，render() 变成空操作（Node 断言走这条路）
      this.categoryBar = null;
      this.searchInput = null;
      this.statusLine = null;
      this.list = null;
      return;
    }

    const doc = this.doc;
    style(container, { display: 'flex', flexDirection: 'column', gap: '6px' });

    // ---- 分类按钮条
    const bar = doc.createElement('div');
    style(bar, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    this.categoryBar = bar;
    // 「全部」+ 7 个分类
    const makeChip = (label: string, value: string | null): HTMLButtonElement => {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.textContent = label;
      chip.dataset['category'] = value ?? '*';
      // 分类按钮沿用项目对手机上可点面积的要求（≥44px），不为了"紧凑"缩到点不中的高度
      style(chip, STYLE_BUTTON);
      chip.addEventListener('click', () => this.setCategory(value));
      return chip;
    };
    bar.appendChild(makeChip('全部', null));
    for (const category of HELP_CATEGORIES) bar.appendChild(makeChip(category, category));
    container.appendChild(bar);

    // ---- 搜索框
    const input = doc.createElement('input');
    input.type = 'search';
    input.placeholder = '搜索：例如「水 冻结」「怎么保存」「重力」';
    input.id = 'help-search';
    style(input, {
      minHeight: '36px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid #2b3640',
      background: 'rgba(12, 16, 20, 0.9)',
      color: '#d8e2ea',
      font: 'inherit',
    });
    // `input` 事件在中文输入法组合期间也会触发，但那时 value 已经是候选字的一部分，
    // 直接搜不会出错（最多是"搜到一半"），所以不做 compositionend 的特殊处理
    input.addEventListener('input', () => {
      this.query = input.value;
      this.renderList();
    });
    this.searchInput = input;
    container.appendChild(input);

    // ---- 状态行（搜到几条 / 没有结果的原因）
    const status = doc.createElement('div');
    style(status, { color: '#8b9aa8', fontSize: '12px', minHeight: '16px' });
    this.statusLine = status;
    container.appendChild(status);

    // ---- 条目列表（可滚动，避免把整个页面撑长）
    const list = doc.createElement('div');
    list.id = 'help-list';
    style(list, { display: 'flex', flexDirection: 'column', maxHeight: '46vh', overflowY: 'auto' });
    this.list = list;
    container.appendChild(list);

    this.render();
  }

  /**
   * 搜索（面板里敲字走这里；外部也可以直接调）。
   *
   * `query` 会**同步写回搜索框**：这样外部调 `search('水')` 之后，
   * 面板里显示的关键字和实际结果是一致的 —— 否则玩家会看到"框里空着、列表却只剩 3 条"。
   */
  search(query: string): readonly HelpTopic[] {
    this.query = query;
    if (this.searchInput && this.searchInput.value !== query) this.searchInput.value = query;
    const results = this.searchTopics();
    this.renderList();
    return results;
  }

  /** 切换分类（null = 全部） */
  setCategory(category: string | null): void {
    this.category = category;
    this.render();
  }

  /** 当前分类（null = 全部） */
  get currentCategory(): string | null {
    return this.category;
  }

  /** 当前查询原文 */
  get currentQuery(): string {
    return this.query;
  }

  /** 分类过滤 + 搜索之后的条目（面板渲染的就是它） */
  private searchTopics(): readonly HelpTopic[] {
    const matched = searchHelpTopics(this.query);
    if (!this.category) return matched;
    return matched.filter((topic) => topic.category === this.category);
  }

  /** 全量重画（分类条高亮 + 列表） */
  render(): void {
    if (this.disposed) return;
    this.renderCategoryBar();
    this.renderList();
  }

  private renderCategoryBar(): void {
    if (!this.categoryBar) return;
    // 分类条是构造时建好的，这里只改高亮：不重建节点，避免每次点击都丢焦点
    for (const chip of Array.from(this.categoryBar.children)) {
      const el = chip as HTMLButtonElement;
      const active = (el.dataset['category'] ?? '*') === (this.category ?? '*');
      el.style.borderColor = active ? '#7fd06a' : '#2b3640';
      el.style.fontWeight = active ? '700' : '400';
    }
  }

  /** 重画列表（搜索/分类变化时调用；条目数并不多，所以整体重建最简单也最不容易出错） */
  private renderList(): void {
    if (this.disposed) return;
    const list = this.list;
    const doc = this.doc;
    if (!list || !doc) return;

    const topics = this.searchTopics();
    list.textContent = '';

    if (this.statusLine) {
      const filtered = this.category ? `（分类：${this.category}）` : '';
      this.statusLine.textContent =
        topics.length > 0
          ? `找到 ${topics.length} 条${filtered}`
          : `没有匹配「${this.query}」的条目${filtered} —— 换个词试试：水、重力、存档、快捷键`;
    }

    for (const topic of topics) {
      list.appendChild(this.buildCard(topic));
    }
  }

  /** 一条可折叠的帮助（用 details/summary：不用自己写展开逻辑，键盘也能操作） */
  private buildCard(topic: HelpTopic): HTMLElement {
    const doc = this.doc!;
    const details = doc.createElement('details');
    details.id = `help-topic-${topic.id}`;
    details.open = this.expanded.has(topic.id);
    style(details, STYLE_CARD);
    details.addEventListener('toggle', () => {
      if (details.open) this.expanded.add(topic.id);
      else this.expanded.delete(topic.id);
    });

    const summary = doc.createElement('summary');
    summary.textContent = `${topic.category}｜${topic.question}`;
    style(summary, { cursor: 'pointer' });
    details.appendChild(summary);

    const answer = doc.createElement('p');
    answer.textContent = topic.answer;
    style(answer, { margin: '6px 0 0', lineHeight: '1.6' });
    details.appendChild(answer);

    // 相关快捷键 / 工具
    if (topic.related && topic.related.length > 0) {
      const related = doc.createElement('div');
      style(related, { marginTop: '6px', color: '#8b9aa8', fontSize: '12px' });
      related.textContent = `相关：${topic.related.join(' · ')}`;
      details.appendChild(related);
    }

    // 「打开示例」：按分类挑一个真实存在的示例，点了走 handlers.onOpenExample
    const example = this.exampleForTopic(topic);
    if (example) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = `${example.emoji} 打开示例：${example.name}`;
      button.title = describeExample(example);
      style(button, { ...STYLE_BUTTON, marginTop: '6px' });
      button.addEventListener('click', () => {
        this.handlers.onOpenExample?.(example.id);
      });
      details.appendChild(button);
    }

    return details;
  }

  /**
   * 这条帮助配哪个示例。
   *
   * 用**分类 → 示例 id** 的固定映射（而不是"猜关键词"）：
   * 猜关键词会在文案改一个字之后静默失效，而这张表改错了
   * `validateExample` / 断言里的"示例 id 必须存在"能立刻抓到。
   */
  private exampleForTopic(topic: HelpTopic): ExampleScene | undefined {
    const id = HELP_EXAMPLE_BY_CATEGORY[topic.category];
    if (!id) return undefined;
    return EXAMPLE_SCENES.find((scene) => scene.id === id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 把容器里自己建的节点整棵摘掉：分类按钮与搜索框的监听器都挂在那些节点上，
    // 节点被移除后它们不可能再被触发（本类没有 window / document 级监听器）。
    // 这样比逐个 removeEventListener 更不容易漏 —— dispose 漏一个监听器是很难发现的一类 bug。
    if (this.root) this.root.textContent = '';
    this.expanded.clear();
  }
}

/** 每个帮助分类配一个代表性示例（id 都来自 `tutorial/Examples.ts` 的真实场景） */
export const HELP_EXAMPLE_BY_CATEGORY: Record<string, string> = {
  基础: 'block_tower',
  地形: 'desert_oasis',
  建筑: 'combined_town',
  物理: 'rolling_ball_ramp',
  流体: 'pool_and_boat',
  存档: 'domino',
  快捷键: 'drawbridge',
};
