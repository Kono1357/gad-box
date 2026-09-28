/**
 * 新手教学关卡数据。
 *
 * 这一层是**纯数据**：不引用 Three.js、不引用 Rapier、不碰 DOM。
 * 教学系统（tutorial/TutorialRuntime.ts）负责读它、驱动 UI、判定完成条件，
 * 关卡数据本身只描述"教什么、按什么顺序教、卡住时说什么"。
 *
 * 两个约定（和 building/types.ts、data/jointTypes.ts 保持一致）：
 * 1. `starterObjects.position` 是**相对关卡原点的世界偏移**，y 从 0 起（地面）。
 * 2. `starterJoints.bodyA` / `bodyB` 在模板数据里写 **objects 下标的字符串**（'0'、'1'），
 *    空字符串 `''` 表示连到"世界"这个静态参考系。解析规则见
 *    PhysicsFramework.resolveJointBodies()。
 *
 * 教学节奏：place（放对东西）→ joint（连对关节）→ interact（看物理跑起来）。
 * 每一关都只引入一个新概念，hint 只在玩家卡住时才显示，避免一开始就剧透。
 */

import type { BuildingPiece } from '../building/types';
import type { JointConfig, JointType } from '../data/jointTypes';

/** 一步的目标 */
export interface TutorialStep {
  /** 提示文字（中文，要有"做什么/为什么"） */
  text: string;
  /** 完成条件的类型 */
  goal: 'place' | 'joint' | 'trigger' | 'interact' | 'manual';
  /** 需要放置的模型 id（goal = 'place' 时用） */
  targetDefId?: string;
  /** 需要放置的数量（默认 1） */
  count?: number;
  /** 需要建立的关节类型（goal = 'joint' 时用） */
  jointTypes?: JointType[];
  /** 隐藏提示，卡住时才显示 */
  hint?: string;
}

export interface TutorialLevel {
  id: string;
  name: string;
  description: string;
  /** emoji */
  icon: string;
  /** 步骤列表，按顺序完成 */
  steps: TutorialStep[];
  /** 完成后解锁的下一关 id；最后一关不填 */
  nextId?: string;
  /** 关卡开始时直接给玩家的部件（玩家不用从零搭） */
  starterObjects: BuildingPiece[];
  /** 关卡开始时就建好的关节 */
  starterJoints: JointConfig[];
  /** 关卡提示：本关想教会什么 */
  teaching: string;
}

export const TUTORIAL_LEVELS: TutorialLevel[] = [
  // 关卡 1：会开的门 —— 认识旋转关节
  {
    id: 'level_door',
    name: '会开的门',
    description: '理解门为什么能绕着门轴转 —— 这是最基础的旋转关节。',
    icon: '🚪',
    teaching: '认识旋转关节：门为什么能绕着门轴转',
    starterObjects: [
      { defId: 'door_frame', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
    ],
    starterJoints: [],
    steps: [
      {
        text: '从「建筑」面板拿一扇木门，把它放进门框的空档里。',
        goal: 'place',
        targetDefId: 'door_wood',
        count: 1,
        hint: '在面板搜索框输入「门」，选中木门后把光标移到门框中间，点一下左键确认放置。',
      },
      {
        text: '选中门和门框，给它们加一个旋转关节，让门能绕轴转。',
        goal: 'joint',
        jointTypes: ['revolute'],
        hint: '旋转关节就是一根看不见的轴：门轴要竖直，锚点放在门框合页那一侧。',
      },
      {
        text: '按播放键恢复模拟，然后用手推门，门会绕着刚才那根轴转开。',
        goal: 'interact',
        hint: '如果门纹丝不动，说明关节锚点没落在门上，或者轴方向错了，回上一步重新连。',
      },
    ],
    nextId: 'level_cart',
  },

  // 关卡 2：四轮小车 —— 旋转关节的第二种用法
  {
    id: 'level_cart',
    name: '四轮小车',
    description: '轮子能自由转，车才跑得动 —— 同样是旋转关节，用法却完全不同。',
    icon: '🛒',
    teaching: '认识旋转关节的第二种用法：轮子为什么要能转，车才能动',
    starterObjects: [
      { defId: 'floor_wood', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    starterJoints: [],
    steps: [
      {
        text: '在车板下面放四个轮子，位置对称，前后左右各一个。',
        goal: 'place',
        targetDefId: 'wheel',
        count: 4,
        hint: '轮子要贴着车板下沿，别陷进板子里；四个轮子的高度保持一致，车才不会歪。',
      },
      {
        text: '给每个轮子都加一个旋转关节，转轴统一沿 X 方向。',
        goal: 'joint',
        jointTypes: ['revolute'],
        hint: '四个轮子的轴必须同向且互相平行，否则有的往前有的往后，车只会原地打转。',
      },
      {
        text: '按播放恢复模拟，轻轻推一下车身，轮子转动，车就滑出去了。',
        goal: 'interact',
        hint: '车不动就检查轮子是不是真的能转：轴上传动被限位设成 0 度，轮子就等于锁死了。',
      },
    ],
    nextId: 'level_bridge',
  },

  // 关卡 3：吊桥 —— 绳索关节与并联约束
  {
    id: 'level_bridge',
    name: '吊桥',
    description: '两根绳子就能把桥面吊在半空 —— 这是绳索关节的"只能拉不能推"。',
    icon: '🌉',
    teaching: '认识绳索关节与并联约束：为什么两根绳子能把桥吊起来',
    starterObjects: [
      { defId: 'pillar_stone', position: [-3, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'pillar_stone', position: [3, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
    ],
    starterJoints: [],
    steps: [
      {
        text: '在两个桥墩之间铺一块木地板，当作以后会升降的桥面。',
        goal: 'place',
        targetDefId: 'floor_wood',
        count: 1,
        hint: '桥面要比桥墩顶面低一点，留出被绳子吊起的空间，别直接压在桥墩上。',
      },
      {
        text: '用绳索关节把桥面的左端吊到左桥墩、右端吊到右桥墩。',
        goal: 'joint',
        jointTypes: ['rope'],
        count: 2,
        hint: '绳索只能拉不能推，所以桥面会一直往下坠，坠到绳子拉直才被吊住，这是正常现象。',
      },
      {
        text: '在桥头放一个发光方块当触发器，让路过的箱子能压到它。',
        goal: 'trigger',
        targetDefId: 'light_block',
        count: 1,
        hint: '触发器贴在桥面入口的地面上，箱子经过时碰到它，就代表"上桥"这件事发生了。',
      },
      {
        text: '按播放恢复模拟，看桥面下坠到绳子拉直，然后被稳稳吊在半空。',
        goal: 'interact',
        hint: '如果桥面直接砸到地上，多半是绳子太长或者锚点没连在桥墩上，回上一步检查。',
      },
    ],
  },
];

export function getTutorialLevel(id: string): TutorialLevel | undefined {
  return TUTORIAL_LEVELS.find((level) => level.id === id);
}
