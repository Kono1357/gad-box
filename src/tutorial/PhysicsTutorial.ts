/**
 * 物理教学关卡数据 + 目标状态机（M2.5 / 物理教学）。
 *
 * 这一层是**纯逻辑**：不引用 Three.js、不引用 Rapier、不引用 Engine、不碰 DOM，
 * 因此在 Node 里 `import` 与 `new PhysicsTutorialRunner()` 都不会崩，
 * 引擎侧只要每帧把一份 `PhysicsTutorialWorldState` 喂给 `evaluate()` 即可。
 * 渲染成什么样由 `src/ui/PhysicsTutorialUI.ts` 负责，本文件连一个中文标签之外的 UI 概念都没有。
 *
 * 两个约定（和已有的 tutorial/TutorialLevel.ts 保持一致）：
 * 1. `starterObjects.position` 是**相对关卡原点的世界偏移**，y 从 0 起（地面）；
 * 2. 关卡数据只描述"教什么、按什么顺序教、卡住时说什么"，
 *    判定所需的**世界现状**由 Engine 采集后通过 `evaluate()` 参数传入 ——
 *    状态机自己不去读引擎，这样它才能在 Node 里用假 state 断言。
 *
 * 中文名一律**引用别处的表**，不在这里另抄一份：
 * - 关节类型 → data/jointTypes.ts 的 JOINT_TYPE_LABELS；
 * - 重力预设 → data/gravityPresets.ts 的 GRAVITY_PRESETS（id 就是
 *   'earth' | 'moon' | 'mars' | 'jupiter' | 'zero'，中文名取那边的 name）；
 * - 模型名 → data/buildingCatalog.ts 的 getBuildingDef()。
 *
 * 只有**物理材质**是一张本地小表（PHYSICS_MATERIAL_LABELS）：全项目还没有物理材质表，
 * 这里只列教学用到的四个 id 与中文名，材质表建好后应改成从那张表取名字。
 */

import type { JointType } from '../data/jointTypes';
import { JOINT_TYPE_LABELS } from '../data/jointTypes';
import { getBuildingDef } from '../data/buildingCatalog';
import { GRAVITY_PRESETS, configForPreset } from '../data/gravityPresets';

/** 教学里"要玩家做的一件事"的完成判定方式 */
export type PhysicsGoalKind =
  | 'place-object'      // 放下指定模型 N 个
  | 'set-gravity'       // 把重力切到指定预设
  | 'set-material'      // 给物体设成指定物理材质
  | 'create-joint'      // 创建指定类型的关节
  | 'apply-force'       // 给物体加一次冲量（Engine 提供按钮）
  | 'run-steps'         // 让物理连续跑够 N 步（观察用）
  | 'trigger-zone'      // 让某个物体进入触发区
  | 'see-collapse'      // 观察到一次局部倒塌
  | 'see-float'         // 观察到某个物体在水面停留 N 秒
  | 'manual';           // 引擎检测不了，只能玩家自己点「我做完了」

export interface PhysicsGoal {
  kind: PhysicsGoalKind;
  /** 需要的模型 id（place-object / see-float / see-collapse 用） */
  defId?: string;
  /** 需要几个（默认 1） */
  count?: number;
  /** 需要的关节类型（create-joint 用） */
  jointType?: JointType;
  /** 需要的重力预设 id（set-gravity 用） */
  gravityPreset?: string;
  /** 需要的物理材质 id（set-material 用） */
  materialId?: string;
  /** 冲量大小（apply-force 用，牛·秒） */
  impulse?: number;
  /** 触发区 tag（trigger-zone 用） */
  triggerTag?: string;
  /** 需要多少步 / 多少秒（run-steps / see-float 用） */
  duration?: number;
  /** 中文判据描述，面板上直接显示（例如「橡胶球弹回原高度的 60% 以上」） */
  description: string;
}

export interface PhysicsTutorialStep {
  id: string;
  title: string;
  /** 中文说明（30~60 字，讲清"做什么"和"为什么要这么做"） */
  text: string;
  /** 提示（玩家卡住时显示，40~70 字） */
  hint: string;
  goals: PhysicsGoal[];
  /**
   * 这一步是否需要在世界里放好起始道具才能开始（Engine 会按 starterObjects 摆）。
   * false = 玩家从空世界开始自己动手。
   */
  needsStarter: boolean;
}

export interface PhysicsTutorialLevel {
  id: string;
  name: string;
  emoji: string;
  /** 一句话主题 */
  summary: string;
  /** 这一关推荐的重力预设（进入时 Engine 会切） */
  gravityPreset: string;
  /** 起始道具（相对世界原点的偏移），为空表示从空世界开始 */
  starterObjects: { defId: string; position: [number, number, number]; rotationY: number }[];
  steps: PhysicsTutorialStep[];
  /** 通关条件的中文描述 */
  completion: string;
  /** 建议用时（分钟），用于面板显示 */
  estimatedMinutes: number;
}

/**
 * 地球档的物理步频（60 Hz，对应 config.ts 的 PHYSICS_CONFIG.fixedTimeStep = 1/60）。
 *
 * `run-steps` 的 duration 是**步数**，内部计时器记的是秒：换算时优先用
 * data/gravityPresets.ts 里当前预设的 timestep（木星档是 1/120），
 * 只有在拿不到有效 timestep 时才退回这个常量。
 */
export const PHYSICS_STEPS_PER_SECOND = 60;

/** 一整关跳过（放弃）的次数上限：留给"实在卡住"的玩家，不多给，避免一路点过去 */
export const PHYSICS_TUTORIAL_MAX_SKIPS = 3;

/**
 * 教学里会用到的物理材质 id → 中文名。
 *
 * ⚠️ 这是本文件**唯一**一张本地名表：物理材质表（摩擦 / 恢复系数）全项目还没建，
 * 这里只列教学用到的四个 id，命名与体素材质表的 key 保持一致（冰 / 泥巴）。
 * 材质表建好后，Engine 可以把它覆盖成从材质表取的 name，或者直接删掉这里。
 */
export const PHYSICS_MATERIAL_LABELS: Record<string, string> = {
  ice: '冰',
  mud: '泥巴',
  rubber: '橡胶',
  steel: '钢材',
};

/** 材质 id → 中文名（查不到就原样返回 id，绝不为了让文案好看而编一个名字） */
function materialLabel(id: string | undefined): string {
  if (!id) return '未知材质';
  return PHYSICS_MATERIAL_LABELS[id] ?? id;
}

/** 重力预设 id → 中文名；名字来自 data/gravityPresets.ts，未知 id 原样返回（不冒充地球） */
function gravityLabel(id: string): string {
  if (!id) return '未知重力';
  return GRAVITY_PRESETS.find((preset) => preset.id === id)?.name ?? id;
}

/**
 * 当前重力预设下走一步物理要多少秒。
 *
 * 不能写死 1/60：木星档的固定步长是 1/120（见 gravityPresets.ts 的 TUNING），
 * 同样跑 3 秒，步数翻倍 —— `run-steps` 的 duration 是步数，换算必须跟着预设走。
 * 取不到时退回 PHYSICS_STEPS_PER_SECOND 对应的 1/60。
 */
function stepSecondsFor(gravityPreset: string): number {
  const timestep = configForPreset(gravityPreset).timestep;
  if (!Number.isFinite(timestep) || timestep <= 0) return 1 / PHYSICS_STEPS_PER_SECOND;
  return timestep;
}

/** defId → 中文名；只用真实建筑库里的 id，查不到时退回 id 本身（不猜名字） */
function defLabel(defId: string | undefined): string {
  if (!defId) return '物体';
  return getBuildingDef(defId)?.name ?? defId;
}

/** 目标里要的数量：缺省 1，非法值也当 1（脏存档不能让它变成 0 或负数） */
function goalCount(goal: PhysicsGoal): number {
  const raw = goal.count;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 把存档里的下标夹到合法范围内；不是有限数就返回 null（调用方决定保留旧值） */
function clampIndex(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return Math.min(max, Math.max(min, floored));
}

// ============================================================================
// 关卡数据
//
// defId 全部来自 src/data/buildings/（structure.ts + props.ts）的真实模型，
// 文案里的质量 / 摩擦系数 / 恢复系数也是模型自带的真值，不是编的：
//   花瓶 43 kg / 摩擦 0.4 / 恢复 0.15，石柱 8800 kg / 0.85 / 0.04，
//   柜子 376 kg / 0.65 / 0.1，木坡（缓坡）0.65，轮子（橡胶）152 kg / 0.5，
//   小艇 332 kg，混凝土地基 47520 kg，木梁 6 m / 653 kg，门框 1.35 m，木门 0.9 m。
// ============================================================================

export const PHYSICS_TUTORIAL_LEVELS: readonly PhysicsTutorialLevel[] = [
  // ---------------------------------------------------------------- 第 1 关
  {
    id: 'phys_gravity',
    name: '重力与掉落',
    emoji: '🍎',
    summary: '东西有重量就会往下掉，重的轻的下落一样快',
    gravityPreset: 'earth',
    starterObjects: [],
    estimatedMinutes: 4,
    completion: '让花瓶和石柱从同一高度落下、切到月球再落一次、看清受力箭头，就算通关',
    steps: [
      {
        id: 'gravity_place',
        title: '同一高度放两个物体',
        text: '从 5 米高处放下一个花瓶（43 kg）和一根石柱（8800 kg），让两者底面一样高 —— 重量差了 200 倍。',
        hint: '在建筑面板搜「花瓶」和「石柱」；先把视角抬高再放置，两个物体的底面要对齐，落地才比得出来。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'vase',
            count: 1,
            description: '放下 1 个花瓶（43 kg 的轻物）',
          },
          {
            kind: 'place-object',
            defId: 'pillar_stone',
            count: 1,
            description: '放下 1 根石柱（8800 kg 的重物）',
          },
        ],
      },
      {
        id: 'gravity_drop',
        title: '跑起来看落地',
        text: '按播放让物理连续跑够 3 秒：两者下落快慢一模一样，可落地表现不同 —— 花瓶弹一下，石柱几乎不动。',
        hint: '如果两个物体没动，说明物理暂停着，再按一次播放键；已经躺在地上的话，重新抬到高处再放一次。',
        needsStarter: false,
        goals: [
          {
            kind: 'run-steps',
            duration: 180,
            description: '让物理连续跑够 180 步（3 秒），看两个物体同时落地',
          },
        ],
      },
      {
        id: 'gravity_moon',
        title: '切到月球重力',
        text: '把重力预设切到「月球」再跑 2 秒：重力小了，同样的高度要落得更久，落地冲击也小得多。',
        hint: '重力预设在下拉框里，进关卡时默认「地球」；切完要重新把物体抬到高处，它们才有力气再落一次。',
        needsStarter: false,
        goals: [
          {
            kind: 'set-gravity',
            gravityPreset: 'moon',
            description: '把重力预设切到「月球」（1.62 m/s²）',
          },
          {
            kind: 'run-steps',
            duration: 120,
            description: '在月球重力下再跑够 120 步（2 秒）',
          },
        ],
      },
      {
        id: 'gravity_arrows',
        title: '看清"重量"这件事',
        text: '打开物理调试面板的受力箭头，比一比两个物体的箭头长度 —— 箭头长代表重力大，跟下落速度无关。',
        hint: '调试面板的「受力箭头」打开后，物体上会出现向下的箭头：重物的箭头明显更长，但两者依然同时落地。',
        needsStarter: false,
        // 为什么只能人工确认：Engine 上报的世界状态里只有数量 / 材质 / 重力预设，
        // 没有"玩家是否打开了受力箭头、有没有看懂"这类渲染设置与主观判断。
        // 硬要自动判定就得去读调试面板的 UI 状态，那是在猜，不如让玩家自己点确认。
        goals: [
          {
            kind: 'manual',
            description: '我打开了受力箭头，看清重物的箭头更长、但下落速度和它无关',
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------- 第 2 关
  {
    id: 'phys_friction',
    name: '摩擦力与斜坡',
    emoji: '⛷️',
    summary: '冰面滑、泥地黏，坡度越陡越站不住',
    gravityPreset: 'earth',
    // 坡是"缓坡"（斜坡模型：深 3 米、高 0.9 米，约 17°，六段递进台阶），
    // 坡底摆一块光源方块当触发区，Engine 需要给它打上 tag 'ramp_bottom'。
    starterObjects: [
      { defId: 'ramp_wood', position: [0, 0, 0], rotationY: 0 },
      { defId: 'floor_wood', position: [0, 0, -3.5], rotationY: 0 },
      { defId: 'light_block', position: [0, 0, -2.2], rotationY: 0 },
    ],
    estimatedMinutes: 5,
    completion: '同一块滑块分别用冰和泥巴各滑一次，并能说出坡度变陡会怎样，就算通关',
    steps: [
      {
        id: 'friction_slider',
        title: '把滑块放上坡顶',
        text: '拿一个柜子放在缓坡最高处当滑块，先什么都别改：柜子摩擦 0.65、木坡也是 0.65，缓坡上它站得住。',
        hint: '柜子在建筑面板的家具分类里；坡顶在 +Z 那侧、离地 0.9 米，放置时让柜子底面贴住最高一级台阶。',
        needsStarter: true,
        goals: [
          {
            kind: 'place-object',
            defId: 'cabinet_wood',
            count: 1,
            description: '在坡顶放下 1 个柜子当滑块',
          },
          {
            kind: 'run-steps',
            duration: 120,
            description: '让物理跑够 120 步（2 秒），确认滑块在缓坡上站住',
          },
        ],
      },
      {
        id: 'friction_ice',
        title: '把滑块换成冰面',
        text: '把滑块的物理材质设成「冰」，再跑 3 秒 —— 摩擦几乎消失，它会顺着台阶一路蹭到坡底触发区。',
        hint: '选中柜子后在物理面板的材质下拉里选「冰」；滑下去要压到坡底那块光源方块，没压到就把它挪近些。',
        needsStarter: true,
        goals: [
          {
            kind: 'set-material',
            materialId: 'ice',
            description: '把滑块材质设成「冰」（摩擦接近 0）',
          },
          {
            kind: 'trigger-zone',
            triggerTag: 'ramp_bottom',
            count: 1,
            description: '让滑块滑到坡底、压到触发区',
          },
          {
            kind: 'run-steps',
            duration: 180,
            description: '让物理跑够 180 步（3 秒）看它滑到底',
          },
        ],
      },
      {
        id: 'friction_mud',
        title: '再换成泥巴',
        text: '把材质换成「泥巴」：摩擦系数接近 1，它像被黏在坡上一样，同样跑 2 秒几乎一动不动。',
        hint: '换完材质要重新播放物理；如果它还在往下滑，多半是上一次的冰面材质没真正换掉，重新选中再设一次。',
        needsStarter: true,
        goals: [
          {
            kind: 'set-material',
            materialId: 'mud',
            description: '把滑块材质设成「泥巴」（摩擦接近 1）',
          },
          {
            kind: 'run-steps',
            duration: 120,
            description: '让物理跑够 120 步（2 秒），看泥地把它黏住',
          },
        ],
      },
      {
        id: 'friction_angle',
        title: '把坡垫陡再试',
        text: '在坡底那侧再叠一块木地板把坡度垫陡，让冰和泥巴都再滑一次，看谁先撑不住往下溜。',
        hint: '坡度越陡，需要的静摩擦越大：坡角的正切值 tan(θ) 超过摩擦系数，物体就一定滑，这就是陡坡难站住的原因。',
        needsStarter: true,
        // 为什么只能人工确认：世界状态里只有材质用量与触发次数，没有坡度数据；
        // 坡是玩家自己垫的，引擎不知道他垫了多高，"够不够陡"这个判断测不出来。
        goals: [
          {
            kind: 'manual',
            description: '我把坡垫陡又滑了一次，能说出"太陡了连泥巴也挡不住"',
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------- 第 3 关
  {
    id: 'phys_bounce',
    name: '弹性与反弹',
    emoji: '🏀',
    summary: '恢复系数决定弹不弹、弹多高',
    gravityPreset: 'earth',
    starterObjects: [],
    estimatedMinutes: 4,
    completion: '让轮子和石柱同高度落下、比较反弹、再用橡胶材质把一个不弹的物体变弹，就算通关',
    steps: [
      {
        id: 'bounce_place',
        title: '同高度放两个物体',
        text: '从同一高度放下一个轮子（152 kg）和一根石柱（8800 kg）：轮子外圈是橡胶，石柱是硬石头。',
        hint: '两个物体要放在同一高度、彼此隔开一点，落地时不要互相撞到，否则看不出"到底谁弹得高"。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'wheel',
            count: 1,
            description: '放下 1 个轮子（橡胶外圈，恢复系数 0.5）',
          },
          {
            kind: 'place-object',
            defId: 'pillar_stone',
            count: 1,
            description: '放下 1 根石柱（硬石头，恢复系数 0.04）',
          },
        ],
      },
      {
        id: 'bounce_drop',
        title: '看谁弹得起来',
        text: '跑 5 秒看落地：轮子会弹起好几次，石柱几乎贴地不动 —— 区别就在恢复系数 0.5 对 0.04。',
        hint: '恢复系数就是"弹回来的能力"：0 表示完全不弹，1 表示一点能量都不损失；石柱的 0.04 等于不弹。',
        needsStarter: false,
        goals: [
          {
            kind: 'run-steps',
            duration: 300,
            description: '让物理跑够 300 步（5 秒），看轮子反复弹、石柱不弹',
          },
        ],
      },
      {
        id: 'bounce_rubber',
        title: '把石柱换成橡胶',
        text: '把石柱的材质临时换成「橡胶」，再跑 3 秒 —— 同一个物体，恢复系数变了，它也会开始弹。',
        hint: '材质改的是摩擦与恢复系数，不改形状和质量；换完重新抬到高处再放，它才有机会弹给你看。',
        needsStarter: false,
        goals: [
          {
            kind: 'set-material',
            materialId: 'rubber',
            description: '把石柱材质设成「橡胶」（恢复系数大幅提高）',
          },
          {
            kind: 'run-steps',
            duration: 180,
            description: '让物理跑够 180 步（3 秒），看它换材质后也弹起来',
          },
        ],
      },
      {
        id: 'bounce_judge',
        title: '数一数弹了多高',
        text: '盯着第一次反弹，估一估它弹回原高度的百分之几 —— 弹回高度大致是恢复系数的平方。',
        hint: '恢复系数 0.5 的轮子只能弹回约 1/4 高（0.5 的平方），换成橡胶后能弹回一半以上，差距很明显。',
        needsStarter: false,
        // 为什么只能人工确认：世界状态里没有物体的高度轨迹，只有数量与材质统计；
        // "弹回原高度的百分之几"必须靠眼睛比较起落两点，代码测不出来。
        goals: [
          {
            kind: 'manual',
            description: '我数过反弹高度：恢复系数 0.5 的物体只弹回约 1/4 高',
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------- 第 4 关
  {
    id: 'phys_joint',
    name: '关节与门',
    emoji: '🚪',
    summary: '铰链能转不能平移，固定关节把东西焊死',
    gravityPreset: 'earth',
    starterObjects: [
      { defId: 'door_frame', position: [0, 0, 0], rotationY: 0 },
      { defId: 'wall_stone', position: [-3, 0, 0], rotationY: 0 },
    ],
    estimatedMinutes: 6,
    completion: '给门装上旋转关节、给木梁和石墙装上固定关节，能说出两种关节的区别，就算通关',
    steps: [
      {
        id: 'joint_door',
        title: '把门放进框里',
        text: '拿一扇木门放进门框空档里：门框 1.35 米宽、木门 0.9 米宽，放进去后两边要留出转动的缝隙。',
        hint: '门框与木门都在建筑面板的门窗分类；门要立在门框内侧、底面贴地，别插进门框两边的柱子里。',
        needsStarter: true,
        goals: [
          {
            kind: 'place-object',
            defId: 'door_wood',
            count: 1,
            description: '把 1 扇木门放进门框里',
          },
        ],
      },
      {
        id: 'joint_hinge',
        title: '连一个旋转关节',
        text: '给门和门框连一个旋转关节：这根看不见的轴让门能绕轴转，但门和门框的距离永远不变。',
        hint: '旋转关节的轴要竖直（0,1,0），锚点放在门框合页那一侧；锚点跑到门中间，门就会绕着中心乱转。',
        needsStarter: true,
        goals: [
          {
            kind: 'create-joint',
            jointType: 'revolute',
            description: '在门和门框之间建 1 个旋转关节',
          },
          {
            kind: 'run-steps',
            duration: 60,
            description: '跑够 60 步（1 秒），确认门没被关节弹飞',
          },
        ],
      },
      {
        id: 'joint_beam',
        title: '横搭一根木梁',
        text: '再拿一根 6 米木梁横搭到左边那面石墙上，为下一步的"焊死"做准备。',
        hint: '木梁很长，一端搭上石墙顶、另一端先悬空；这会儿搭不稳没关系，下一步的固定关节会让它不再动。',
        needsStarter: true,
        goals: [
          {
            kind: 'place-object',
            defId: 'beam_wood',
            count: 1,
            description: '横着放下 1 根木梁（6 米长）搭到石墙上',
          },
        ],
      },
      {
        id: 'joint_weld',
        title: '把梁焊死在墙上',
        text: '给木梁和石墙加一个固定关节：固定关节把两者的相对位置焊死，既不能转、也不能平移。',
        hint: '对比着记：旋转关节能转不能平移，固定关节两样都不能；想让梁会转就别用它，换球关节或旋转关节。',
        needsStarter: true,
        goals: [
          {
            kind: 'create-joint',
            jointType: 'fixed',
            description: '在木梁和石墙之间建 1 个固定关节',
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------- 第 5 关
  {
    id: 'phys_buoyancy',
    name: '浮力与船',
    emoji: '⛵',
    summary: '排水体积决定浮沉，空心能浮、实心会沉',
    gravityPreset: 'earth',
    // 水面由地图与水体系统提供（本关卡不自带水）；建议在地图里有开阔水域的位置开课
    starterObjects: [],
    estimatedMinutes: 5,
    completion: '让空心小艇在水面浮够 3 秒、让实心地基沉底、看清吃水线变化，就算通关',
    steps: [
      {
        id: 'buoy_boat',
        title: '把船放进水里',
        text: '把一条小艇（332 kg）放进水里：船体是空心的，排开的水的重量顶得住它，这就是浮力。',
        hint: '小艇要放在水面附近、别放到岸上；放下去之后它会自己调整姿态，能浮起来就说明排水体积够大。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'boat_row',
            count: 1,
            description: '把 1 条小艇放进水面',
          },
        ],
      },
      {
        id: 'buoy_float',
        title: '让它在水面待住',
        text: '让物理跑起来，看小艇在水面稳定停留 3 秒：浮力等于排开的水重，船越轻浮得越高。',
        hint: '如果船一直往下沉，多半是放得太靠岸、或者船体被地形卡住了；换到开阔水面重新放一次。',
        needsStarter: false,
        goals: [
          {
            kind: 'see-float',
            defId: 'boat_row',
            duration: 3,
            description: '让空心小艇在水面停留 3 秒不沉',
          },
        ],
      },
      {
        id: 'buoy_stone',
        title: '丢一块实心混凝土地基',
        text: '再往同一片水里放一块 6×0.6×6 的混凝土地基（47520 kg）：实心、整体密度比水大，它会直接沉底。',
        hint: '放在同一片水域才好对比：船浮着、地基沉底，区别不在总重量，而在"同样的重量排开了多少水"。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'foundation_concrete',
            count: 1,
            description: '往水里放下 1 块实心混凝土地基',
          },
          {
            kind: 'run-steps',
            duration: 180,
            description: '跑够 180 步（3 秒），看实心地基沉到水底',
          },
        ],
      },
      {
        id: 'buoy_draft',
        title: '看吃水线的变化',
        text: '往小艇上再压一两根石柱，看吃水线深了多少 —— 装得越重，排开的水越多，船坐得越低。',
        hint: '浮力只有一个公式：浮力 = 排开水的重量；想多装货就得把船体做宽做高，让排水体积变大。',
        needsStarter: false,
        // 为什么只能人工确认：排水体积要算船体浸没部分的体积，
        // 世界状态里既没有水面高度也没有浸没深度，这个比值只能靠玩家眼睛看。
        goals: [
          {
            kind: 'manual',
            description: '我看过空船与载重后的吃水线，能说出"装得越重吃得越深"',
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------- 第 6 关
  {
    id: 'phys_collapse',
    name: '倒塌与支撑',
    emoji: '🏗️',
    summary: '支撑链断了就塌，悬挑太长一定倒',
    gravityPreset: 'earth',
    starterObjects: [],
    estimatedMinutes: 6,
    completion: '搭出"地面→石柱→木梁"的支撑链、用冲量把它打断、再看到悬挑阳台翻倒，就算通关',
    steps: [
      {
        id: 'collapse_pillars',
        title: '立两根石柱',
        text: '先立两根石柱当支撑链的第一环：间距 3 米、底面贴地，链条就是"地面 → 石柱 → 上面的东西"。',
        hint: '石柱 4 米高、8800 kg 很稳；两根的间距要和 6 米木梁对得上，别超过 6 米，否则梁会一头悬空。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'pillar_stone',
            count: 2,
            description: '立起 2 根石柱（间距不超过 6 米）',
          },
        ],
      },
      {
        id: 'collapse_beam',
        title: '把梁搭上去',
        text: '把 6 米木梁横搭在两根石柱顶上：载荷从梁传到柱、再传到地面，这就是一条完整的支撑链。',
        hint: '梁要两端都压在柱顶、端头别悬空太多；只要有一端没搭好，整条支撑链就是断的，梁一定往那边掉。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'beam_wood',
            count: 1,
            description: '把 1 根木梁两端都搭到石柱顶上',
          },
          {
            kind: 'run-steps',
            duration: 120,
            description: '跑够 120 步（2 秒），确认梁在两根柱子之间稳住了',
          },
        ],
      },
      {
        id: 'collapse_hit',
        title: '把支撑链打断',
        text: '用「加冲量」按钮撞左边那根石柱：24000 牛·秒会让 8800 kg 的柱子以约 2.7 m/s 飞出去。',
        hint: '冲量 = 力 × 时间，同样一脚柱子越重速度越小；先把视角对准左边柱子并选中它，再点加冲量按钮。',
        needsStarter: false,
        goals: [
          {
            kind: 'apply-force',
            impulse: 24000,
            count: 1,
            description: '给左边那根石柱加一次 24000 牛·秒的冲量',
          },
        ],
      },
      {
        id: 'collapse_see',
        title: '看它连锁倒下',
        text: '柱子一歪，上面的梁失去支撑就整条链塌下来；再在柱子外侧远远地悬空放一个阳台，看它自己翻倒。',
        hint: '悬挑的道理和石柱一样：没有柱子托着的那一段越长，翻倒的力矩越大，悬挑别超过支承面宽度的两倍。',
        needsStarter: false,
        goals: [
          {
            kind: 'place-object',
            defId: 'balcony',
            count: 1,
            description: '在石柱外侧悬空放下 1 个阳台（悬挑结构）',
          },
          {
            // count 用 2：state.collapses 是**累计**计数，上一步撞倒柱梁已经算掉一次，
            // 这里要的是"再加上悬挑阳台自己翻倒的那一次"，所以判据是累计 2 次。
            kind: 'see-collapse',
            count: 2,
            description: '累计观察到 2 次局部倒塌（被打断的柱梁 + 悬挑阳台翻倒）',
          },
        ],
      },
    ],
  },
];

export function getPhysicsLevel(id: string): PhysicsTutorialLevel | undefined {
  return PHYSICS_TUTORIAL_LEVELS.find((level) => level.id === id);
}

/** 全部关卡的 id 列表（面板渲染进度点用） */
export function physicsTutorialIds(): string[] {
  return PHYSICS_TUTORIAL_LEVELS.map((level) => level.id);
}

/** 引擎每帧喂进来的"世界现状"，状态机据此判断目标是否达成 */
export interface PhysicsTutorialWorldState {
  /** defId → 世界里的数量 */
  objectCounts: Record<string, number>;
  /** 当前重力预设 id */
  gravityPreset: string;
  /** 世界里存在的关节类型集合 */
  jointTypes: JointType[];
  /** materialId → 有多少物体在用 */
  materialUsage: Record<string, number>;
  /** 已经加过冲量的物体数（apply-force 用） */
  impulsesApplied: number;
  /** 当前是否在连续跑物理（run-steps 用） */
  running: boolean;
  /** 触发区 tag → 累计进入次数 */
  triggerHits: Record<string, number>;
  /** 已观察到的倒塌次数 */
  collapses: number;
  /** 已观察到的漂浮秒数（按 defId 计） */
  floatSeconds: Record<string, number>;
}

/**
 * 教学状态机：追踪走到第几关第几步、判断每一步的目标是否达成。
 *
 * 两条设计原则：
 * 1. **判定是纯函数式的**：`evaluate()` 只读传进来的 `state` 与本对象内部的进度，
 *    不写 state、不碰 DOM、不发事件，所以能在 Node 里喂假 state 断言；
 *    唯一的内部副作用是 `run-steps` 的秒表（它必须记住"上一次 evaluate 是什么时候"），
 *    而且这个秒表只由 `nowMs` 决定，同样的输入仍然得到同样的结果。
 * 2. **每一步的 `unmet` 是中文原因列表**，面板直接逐条显示给玩家 ——
 *    "还差什么"比"没做完"有用得多，这是这个功能的体验核心。
 */
export class PhysicsTutorialRunner {
  private readonly levels: readonly PhysicsTutorialLevel[];
  private levelIdx = 0;
  private stepIdx = 0;
  private isActive = false;
  private completed = 0;
  private skipBudget: number = PHYSICS_TUTORIAL_MAX_SKIPS;
  /** 当前步骤是否已达成（由 evaluate 写入，next()/progress() 读） */
  private stepSatisfied = false;
  /** 玩家用「我做完了」确认了本步的 manual 目标 */
  private manualConfirmed = false;
  /** run-steps 的秒表（秒），只在 running 时累加 */
  private runSeconds = 0;
  private lastEvalMs: number | null = null;
  /** 本关计时起点；null = 不知道（restore 之后），这时 elapsedSeconds 返回 0 */
  private levelStartMs: number | null = null;

  constructor(levels: readonly PhysicsTutorialLevel[] = PHYSICS_TUTORIAL_LEVELS) {
    // 允许注入自定义关卡（测试用）；传空数组时退回内置六关，免得整个教学变成空的
    this.levels = levels.length > 0 ? levels : PHYSICS_TUTORIAL_LEVELS;
  }

  get levelIndex(): number {
    return this.levelIdx;
  }

  get stepIndex(): number {
    return this.stepIdx;
  }

  get level(): PhysicsTutorialLevel | null {
    return this.levels[this.levelIdx] ?? null;
  }

  get step(): PhysicsTutorialStep | null {
    return this.level?.steps[this.stepIdx] ?? null;
  }

  get active(): boolean {
    return this.isActive;
  }

  /** 已完成关卡数 */
  get completedLevels(): number {
    return this.completed;
  }

  /** 剩余可跳过次数（面板用它禁用「跳过这一关」） */
  get skipsLeft(): number {
    return this.skipBudget;
  }

  /** 同 skipsLeft 的别名，两种写法都能读到同一个值 */
  get skipsRemaining(): number {
    return this.skipBudget;
  }

  /** 六关是不是都通了 */
  get allComplete(): boolean {
    return this.completed >= this.levels.length;
  }

  /** 本关已用秒数（由 nowMs 差算）；没在教学中或不知道起点时返回 0 */
  elapsedSeconds(nowMs: number): number {
    if (!this.isActive || this.levelStartMs === null) return 0;
    const delta = (nowMs - this.levelStartMs) / 1000;
    if (!Number.isFinite(delta) || delta < 0) return 0;
    return delta;
  }

  /** 从头开始教学 */
  start(nowMs: number): void {
    this.isActive = true;
    this.levelIdx = 0;
    this.stepIdx = 0;
    this.completed = 0;
    this.skipBudget = PHYSICS_TUTORIAL_MAX_SKIPS;
    this.levelStartMs = nowMs;
    this.resetStepProgress();
  }

  /** 退出教学（面板由 Engine 负责隐藏） */
  exit(): void {
    this.isActive = false;
    this.levelStartMs = null;
    this.lastEvalMs = null;
  }

  /** 回到本关第一步 */
  restart(nowMs: number): void {
    if (!this.isActive) return;
    this.stepIdx = 0;
    this.levelStartMs = nowMs;
    this.resetStepProgress();
  }

  /**
   * 推进到下一步。
   *
   * 注意：**不校验当前步骤有没有达成** —— 「下一步」是玩家自己的选择权，
   * 面板会用「未达成清单」和 primary 高亮告诉他有没有做完，想做硬门槛的 Engine
   * 请自己先检查 `evaluate()` 返回的 `stepDone`。
   * 返回值：'advanced'（同一关内前进了一步）/ 'level-complete'（走完本关、已进入下一关）/
   * 'all-complete'（最后一关也走完了）/ 'not-active'（不在教学中）。
   */
  next(nowMs: number): 'advanced' | 'level-complete' | 'all-complete' | 'not-active' {
    const level = this.level;
    if (!this.isActive || !level) return 'not-active';

    if (this.stepIdx < level.steps.length - 1) {
      this.stepIdx += 1;
      this.resetStepProgress();
      return 'advanced';
    }

    // 最后一步：本关算完成（跳过的关卡在 skipLevel 里也已经记过，这里取较大值）
    if (this.completed < this.levelIdx + 1) this.completed = this.levelIdx + 1;

    if (this.levelIdx >= this.levels.length - 1) {
      this.completed = this.levels.length;
      // 通关后**不退出教学模式**：面板还要留在屏幕上显示庆祝与「退出教学」，
      // 玩家想回头复习也可以直接点进度点跳回去。
      this.resetStepProgress();
      return 'all-complete';
    }

    this.levelIdx += 1;
    this.stepIdx = 0;
    this.levelStartMs = nowMs;
    this.resetStepProgress();
    return 'level-complete';
  }

  /**
   * 回到上一步；已经在本关第一步时退到上一关的最后一步。
   *
   * 这个方法没有时间参数，所以**不改用时起点**（改不了），Engine 若需要重新计时，
   * 自己调一次 `restart(nowMs)`。
   */
  prev(): boolean {
    if (!this.isActive) return false;
    if (this.stepIdx > 0) {
      this.stepIdx -= 1;
      this.resetStepProgress();
      return true;
    }
    if (this.levelIdx > 0) {
      this.levelIdx -= 1;
      const level = this.level;
      this.stepIdx = level ? Math.max(0, level.steps.length - 1) : 0;
      this.resetStepProgress();
      return true;
    }
    return false;
  }

  /**
   * 整关跳过（放弃这一关，进下一关）。次数用完返回 'no-skips-left'。
   *
   * 跳过的关卡**也算进 completedLevels** —— 否则进度点会一直空着、
   * 玩家也没法用进度点跳回来复习，反而更难受。
   */
  skipLevel(nowMs: number): 'skipped' | 'all-complete' | 'no-skips-left' | 'not-active' {
    if (!this.isActive) return 'not-active';
    if (this.skipBudget <= 0) return 'no-skips-left';
    this.skipBudget -= 1;

    if (this.levelIdx >= this.levels.length - 1) {
      this.completed = this.levels.length;
      this.resetStepProgress();
      return 'all-complete';
    }

    this.levelIdx += 1;
    this.stepIdx = 0;
    if (this.completed < this.levelIdx) this.completed = this.levelIdx;
    this.levelStartMs = nowMs;
    this.resetStepProgress();
    return 'skipped';
  }

  /**
   * 玩家手动确认（manual 目标用）。
   *
   * 只对"本步确实有 manual 目标"的步骤生效，其余步骤返回 false ——
   * 不然玩家会以为点它就能跳过一切判定。
   * 确认之后要等下一次 `evaluate()` 才会变成 stepDone（那时才拿得到世界现状）。
   */
  confirmStep(nowMs: number): boolean {
    const step = this.step;
    if (!this.isActive || !step) return false;
    if (!step.goals.some((goal) => goal.kind === 'manual')) return false;
    this.manualConfirmed = true;
    // 别把"确认前的最后一帧"到"确认后的第一帧"之间记成一大段跑动时间
    this.lastEvalMs = nowMs;
    return true;
  }

  /**
   * 每帧调用：更新目标达成情况，返回本步是否已完成。
   *
   * 纯函数式的判定 —— 不写 state、不碰 DOM；`unmet` 是中文原因列表，空数组 = 已完成。
   */
  evaluate(
    state: PhysicsTutorialWorldState,
    nowMs: number,
  ): { stepDone: boolean; unmet: string[] } {
    const step = this.step;
    if (!step) {
      this.stepSatisfied = false;
      return { stepDone: false, unmet: [] };
    }

    // ---- 唯一的内部副作用：run-steps 的秒表 ----
    // 物理在跑才累加；单帧最多记 1 秒，免得切后台回来一次补出几十秒的"观察时间"。
    if (state.running && this.lastEvalMs !== null) {
      const dt = (nowMs - this.lastEvalMs) / 1000;
      if (Number.isFinite(dt) && dt > 0) this.runSeconds += Math.min(dt, 1);
    }
    this.lastEvalMs = nowMs;

    const unmet: string[] = [];
    for (const goal of step.goals) {
      const reason = this.unmetReason(goal, state);
      if (reason !== null) unmet.push(reason);
    }

    // 一步里所有目标都达成才算这一步完成；没有目标的步骤视为未完成（数据错误时不要假装通过）
    this.stepSatisfied = step.goals.length > 0 && unmet.length === 0;
    return { stepDone: this.stepSatisfied, unmet };
  }

  /** 当前进度 0~1（含小数步） */
  progress(): number {
    const total = this.levels.reduce((sum, level) => sum + level.steps.length, 0);
    if (total <= 0) return 0;
    if (this.allComplete) return 1;

    let base = 0;
    for (let i = 0; i < this.levelIdx && i < this.levels.length; i++) {
      base += this.levels[i].steps.length;
    }
    const currentSteps = this.level?.steps.length ?? 0;
    const inLevel = Math.min(currentSteps, this.stepIdx + (this.stepSatisfied ? 1 : 0));
    return clamp01((base + inLevel) / total);
  }

  /** 存档：导出/恢复进度（跨平台一致，补充 7） */
  snapshot(): { completedLevels: number; levelIndex: number; stepIndex: number } {
    return {
      completedLevels: this.completed,
      levelIndex: this.levelIdx,
      stepIndex: this.stepIdx,
    };
  }

  /**
   * 恢复进度。
   *
   * 存档可能来自旧版本（关卡数量或步骤数变了），所以**一律夹回合法范围**而不是抛异常：
   * 越界的 levelIndex / stepIndex 会被夹到边界，不是有限数就当这个字段没给。
   * 恢复成功即进入教学状态（active = true），Engine 恢复存档后不要再调 `start()`，
   * 否则会从头开始。用时起点未知，`elapsedSeconds()` 会先返回 0 直到 Engine 调 `restart()`。
   */
  restore(
    data: Partial<{ completedLevels: number; levelIndex: number; stepIndex: number }>,
  ): boolean {
    if (!data || typeof data !== 'object') return false;

    let usable = false;
    const levelIndex = clampIndex(data.levelIndex, 0, Math.max(0, this.levels.length - 1));
    if (levelIndex !== null) {
      this.levelIdx = levelIndex;
      usable = true;
    }

    const stepsInLevel = this.level?.steps.length ?? 0;
    const stepIndex = clampIndex(data.stepIndex, 0, Math.max(0, stepsInLevel - 1));
    if (stepIndex !== null) {
      this.stepIdx = stepIndex;
      usable = true;
    } else {
      this.stepIdx = 0;
    }

    const completed = clampIndex(data.completedLevels, 0, this.levels.length);
    if (completed !== null) {
      this.completed = completed;
      usable = true;
    } else {
      this.completed = this.levelIdx;
    }

    if (!usable) return false;

    // 存档自相矛盾时（已完成 0 关但人在第 4 关）以 levelIndex 为准，
    // 否则进度点会全部锁住，玩家连当前这一关都跳不回去。
    if (this.completed < this.levelIdx) this.completed = this.levelIdx;

    this.isActive = true;
    this.levelStartMs = null;
    this.resetStepProgress();
    return true;
  }

  // ------------------------------------------------------------------ 内部

  /** 换步 / 换关 / 重来时清掉"这一步"的进度 */
  private resetStepProgress(): void {
    this.stepSatisfied = false;
    this.manualConfirmed = false;
    this.runSeconds = 0;
    this.lastEvalMs = null;
  }

  /** 单个目标没达成时的中文原因；达成了返回 null */
  private unmetReason(goal: PhysicsGoal, state: PhysicsTutorialWorldState): string | null {
    const count = goalCount(goal);

    switch (goal.kind) {
      case 'place-object': {
        const have = state.objectCounts[goal.defId ?? ''] ?? 0;
        if (have >= count) return null;
        return `还差 ${count - have} 个${defLabel(goal.defId)}`;
      }

      case 'set-gravity': {
        const want = goal.gravityPreset ?? '';
        if (state.gravityPreset === want) return null;
        return `重力还是「${gravityLabel(state.gravityPreset)}」，没切到「${gravityLabel(want)}」`;
      }

      case 'set-material': {
        const material = goal.materialId ?? '';
        const used = state.materialUsage[material] ?? 0;
        if (used >= count) return null;
        return `还没有物体换成「${materialLabel(material)}」材质（现在是 ${used} / ${count} 个）`;
      }

      case 'create-joint': {
        const type = goal.jointType;
        if (type && state.jointTypes.includes(type)) return null;
        const label = type ? JOINT_TYPE_LABELS[type] : '指定类型的关节';
        return `还没有建出${label}`;
      }

      case 'apply-force': {
        if (state.impulsesApplied >= count) return null;
        const force = goal.impulse ? ` ${goal.impulse} 牛·秒的` : '';
        return `还没加过${force}冲量（${state.impulsesApplied} / ${count} 次）`;
      }

      case 'run-steps': {
        const steps = goal.duration && goal.duration > 0 ? Math.floor(goal.duration) : 60;
        const done = Math.floor(this.runSeconds / stepSecondsFor(state.gravityPreset));
        if (done >= steps) return null;
        const seconds = (steps * stepSecondsFor(state.gravityPreset)).toFixed(0);
        if (!state.running) {
          return `物理没在跑：先按播放，让它连续跑够 ${steps} 步（约 ${seconds} 秒）`;
        }
        return `物理才跑了 ${done} / ${steps} 步，再跑一会儿`;
      }

      case 'trigger-zone': {
        const tag = goal.triggerTag ?? '';
        const hits = state.triggerHits[tag] ?? 0;
        if (hits >= count) return null;
        return `触发区「${tag}」还没被碰到（${hits} / ${count} 次）`;
      }

      case 'see-collapse': {
        if (state.collapses >= count) return null;
        return `还没看到倒塌（${state.collapses} / ${count} 次）`;
      }

      case 'see-float': {
        const seconds = state.floatSeconds[goal.defId ?? ''] ?? 0;
        const need = goal.duration && goal.duration > 0 ? goal.duration : 3;
        if (seconds >= need) return null;
        return `${defLabel(goal.defId)}只在水面停了 ${seconds.toFixed(1)} 秒，还不够 ${need} 秒`;
      }

      case 'manual': {
        if (this.manualConfirmed) return null;
        return `需要你自己确认：${goal.description}`;
      }
    }

    // 未知目标种类（旧存档 / 数据手滑）当未达成处理，并且说清楚是哪里出了问题
    return `未知目标：${String((goal as PhysicsGoal).kind)}`;
  }
}
