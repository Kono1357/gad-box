/**
 * 组合（Combo）模板库 —— 关节玩法的"预置装置"。
 *
 * 每个组合就是一份纯数据：
 * - `objects`：用哪几个模型（`defId`）按什么偏移拼在一起；
 * - `joints`：这些模型之间怎么连（铰链 / 滑轨 / 绳子 / 弹簧 / 电机）。
 *
 * 两条坐标约定（写数据时必须守住，否则放下去当场弹开）：
 * 1. 每个 `BuildingPiece.position` 是**它自己的底面中心**相对组合原点（底面中心）的偏移；
 * 2. 关节 `anchor` 用组合局部坐标，必须落在两个物体真正相接的地方。
 *
 * `bodyA` / `bodyB` 是 `objects` 下标的字符串，`''` 表示连到世界（静态参考系）。
 */

import type { BuildingPiece } from '../building/types';
import type { JointConfig } from './jointTypes';
import { renderThumbnail } from '../group/PrefabSystem';

/**
 * 一个组合模板。
 *
 * 和 Prefab 的区别：组合带着 `joints`，放置后由 PhysicsFramework 建关节；
 * Prefab 只是"一堆摆好的模型"，没有关节。
 */
export interface Combo {
  /** 唯一 id：小写英文 + 下划线 */
  id: string;
  /** 中文名 */
  name: string;
  /** 一句中文说明，讲清"怎么玩" */
  description: string;
  /** 一个 emoji 当缩略图 */
  thumbnail: string;
  /** 分类 */
  category: '门与窗' | '载具' | '机械' | '结构' | '趣味道具';
  /** 2~4 个中文标签 */
  tags: string[];
  /** 组成这个组合的模型（2~6 个） */
  objects: BuildingPiece[];
  /** 物体之间的关节 */
  joints: JointConfig[];
}

// 组合卡片上的预览图由 renderThumbnail(combo.objects) 现场画成 SVG，
// 这里保留一次引用，让"组合 → 缩略图"这条依赖在模块图上看得见。
void renderThumbnail;

export const COMBOS: Combo[] = [
  // 会开的门：门框 + 门（门板刚好卡在门洞里，铰链在左边立柱内侧）
  {
    id: 'door_kit',
    name: '会开的门',
    description: '门框固定在地上，木门挂在左侧门轴上。放好后按播放，把门推开试试。',
    thumbnail: '🚪',
    category: '门与窗',
    tags: ['门', '铰链', '入门'],
    objects: [
      { defId: 'door_frame', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'door_wood', position: [-0.075, 0, 0.06], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '',
        bodyB: '1',
        anchor: [-0.525, 1, 0.06],
        axis: [0, 1, 0],
        limits: { min: 0, max: 1.57 },
        label: '门轴',
      },
    ],
  },

  // 推拉门：门框 + 铁门（沿水平滑轨平推出去）
  {
    id: 'sliding_door_kit',
    name: '推拉门',
    description: '门框固定在原地，门板装在一根水平滑轨上。按播放后把门沿滑轨推出去 1.2 米。',
    thumbnail: '↔️',
    category: '门与窗',
    tags: ['推拉门', '滑轨', '限位'],
    objects: [
      { defId: 'door_frame', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'door_iron', position: [0.15, 0, 0.25], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'prismatic',
        bodyA: '',
        bodyB: '1',
        anchor: [-0.6, 1, 0.25],
        axis: [1, 0, 0],
        limits: { min: 0, max: 1.2 },
        label: '滑轨',
      },
    ],
  },

  // 四轮小车：木底板 + 四个轮子（每只轮子一个旋转关节）
  {
    id: 'cart_with_wheels',
    name: '四轮小车',
    description: '四只轮子装在木板底盘下面，各转各的。按播放后推它一把，看它滚出去。',
    thumbnail: '🛒',
    category: '载具',
    tags: ['小车', '轮子', '滚动'],
    objects: [
      { defId: 'floor_wood', position: [0, 0.8, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'wheel', position: [-1.6, 0, 1.6], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'wheel', position: [1.6, 0, 1.6], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'wheel', position: [-1.6, 0, -1.6], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'wheel', position: [1.6, 0, -1.6], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [-1.6, 0.4, 1.6],
        axis: [1, 0, 0],
        label: '左前轮轴',
      },
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '2',
        anchor: [1.6, 0.4, 1.6],
        axis: [1, 0, 0],
        label: '右前轮轴',
      },
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '3',
        anchor: [-1.6, 0.4, -1.6],
        axis: [1, 0, 0],
        label: '左后轮轴',
      },
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '4',
        anchor: [1.6, 0.4, -1.6],
        axis: [1, 0, 0],
        label: '右后轮轴',
      },
    ],
  },

  // 手推车：底板 + 把手立柱 + 两个后轮
  {
    id: 'handcart',
    name: '手推车',
    description: '两轮手推车，播放后推着它跑；轮子在后面，不扶着把手就会往前倾。',
    thumbnail: '🧺',
    category: '载具',
    tags: ['手推车', '两轮', '把手'],
    objects: [
      { defId: 'floor_wood', position: [0, 0.8, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'wheel', position: [-1.4, 0, -1.2], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'wheel', position: [1.4, 0, -1.2], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'pillar_stone', position: [0, 1.05, 1.7], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [-1.4, 0.4, -1.2],
        axis: [1, 0, 0],
        label: '左轮轴',
      },
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '2',
        anchor: [1.4, 0.4, -1.2],
        axis: [1, 0, 0],
        label: '右轮轴',
      },
      {
        type: 'fixed',
        bodyA: '0',
        bodyB: '3',
        anchor: [0, 1.05, 1.7],
        label: '把手焊点',
      },
    ],
  },

  // 吊桥：桥面绕地面铰链抬起，两根柱子上的绳子拉住它
  {
    id: 'drawbridge',
    name: '吊桥',
    description: '桥面能绕地面铰链吊起来，两侧柱子上的绳子拉住它。播放后拉绳子试试。',
    thumbnail: '🌉',
    category: '结构',
    tags: ['吊桥', '绳索', '铰链'],
    objects: [
      { defId: 'pillar_stone', position: [-2.6, 0, 1.8], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'pillar_stone', position: [2.6, 0, 1.8], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'floor_wood', position: [0, 0, 0.5], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '',
        bodyB: '2',
        anchor: [0, 0.125, -1.5],
        axis: [1, 0, 0],
        limits: { min: 0, max: 1.4 },
        label: '桥轴',
      },
      {
        type: 'rope',
        bodyA: '0',
        bodyB: '2',
        anchor: [-2.6, 3.7, 1.8],
        length: 3.8,
        damping: 0.6,
        label: '左吊索',
      },
      {
        type: 'rope',
        bodyA: '1',
        bodyB: '2',
        anchor: [2.6, 3.7, 1.8],
        length: 3.8,
        damping: 0.6,
        label: '右吊索',
      },
    ],
  },

  // 吊灯摆锤：天花板块 + 吊灯（一根绳子吊着，能晃）
  {
    id: 'swing_light',
    name: '吊灯摆锤',
    description: '天花板块上吊着一盏灯，绳子让它能晃。播放后推灯一下，看它像摆锤一样摇。',
    thumbnail: '💡',
    category: '趣味道具',
    tags: ['吊灯', '摆锤', '绳索'],
    objects: [
      { defId: 'ceiling_panel', position: [0, 3, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'lamp_ceiling', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'rope',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 3, 0],
        length: 0.6,
        damping: 0.5,
        label: '吊绳',
      },
    ],
  },

  // 弹跳板：弹簧顶着大木板，刚度给得很高
  {
    id: 'spring_board',
    name: '弹跳板',
    description: '弹簧顶着上面的大木板，刚度拉得很高。播放后跳上去，看它能弹多高。',
    thumbnail: '🌀',
    category: '机械',
    tags: ['弹簧', '弹跳', '高刚度'],
    objects: [
      { defId: 'spring', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'floor_wood', position: [0, 0.8, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'spring',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 0.8, 0],
        axis: [0, 1, 0],
        stiffness: 8000,
        damping: 200,
        label: '弹跳弹簧',
      },
    ],
  },

  // 活塞升降台：活塞顶着平台，只能沿竖直方向升降
  {
    id: 'piston_lift',
    name: '活塞升降台',
    description: '活塞杆顶着一块平台，只能沿竖直方向升降。播放后站上去，看它升到 2 米高。',
    thumbnail: '🔩',
    category: '机械',
    tags: ['活塞', '升降', '垂直滑动'],
    objects: [
      { defId: 'piston', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'floor_wood', position: [0, 1.45, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'prismatic',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 1.45, 0],
        axis: [0, 1, 0],
        limits: { min: 0, max: 2 },
        label: '升降导轨',
      },
    ],
  },

  // 齿轮传动：三个齿轮排成一排，第一个带电机
  {
    id: 'gear_train',
    name: '齿轮传动',
    description: '三个齿轮咬在一起排成一排，第一个带电机。播放后整排齿轮会一起转起来。',
    thumbnail: '⚙️',
    category: '机械',
    tags: ['齿轮', '传动', '电机'],
    objects: [
      { defId: 'gear', position: [-0.95, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'gear', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'gear', position: [0.95, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '',
        bodyB: '0',
        anchor: [-0.95, 0.125, 0],
        axis: [0, 0, 1],
        motorSpeed: 2,
        motorForce: 30,
        label: '主动齿轮',
      },
      {
        type: 'revolute',
        bodyA: '',
        bodyB: '1',
        anchor: [0, 0.125, 0],
        axis: [0, 0, 1],
        label: '中间齿轮',
      },
      {
        type: 'revolute',
        bodyA: '',
        bodyB: '2',
        anchor: [0.95, 0.125, 0],
        axis: [0, 0, 1],
        label: '从动齿轮',
      },
    ],
  },

  // 电机轮：柱子当支架，轮子被电机一直转着
  {
    id: 'motor_wheel',
    name: '电机轮',
    description: '支架上装一个电机驱动的轮子，一直以每秒 3 弧度自己转。播放后看它空转。',
    thumbnail: '🛞',
    category: '机械',
    tags: ['电机', '轮子', '自转'],
    objects: [
      { defId: 'pillar_stone', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'wheel', position: [0.9, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [0.55, 0.4, 0],
        axis: [0, 0, 1],
        motorSpeed: 3,
        motorForce: 25,
        label: '驱动轮轴',
      },
    ],
  },

  // 风车：塔柱 + 顶上的四片叶片组成转子（四片各朝一个方向，只在轴心相接）
  {
    id: 'windmill',
    name: '风车',
    description: '塔柱顶上架着四片叶片组成的转子，电机让它慢慢转。播放后当风车看。',
    thumbnail: '🌬️',
    category: '机械',
    tags: ['风车', '叶片', '转子'],
    objects: [
      { defId: 'pillar_stone', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'railing_metal', position: [1.05, 4, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'railing_metal', position: [0, 4, -1.05], rotationY: 1.5708, scale: 1, mode: 'dynamic' },
      { defId: 'railing_metal', position: [-1.05, 4, 0], rotationY: 3.1416, scale: 1, mode: 'dynamic' },
      { defId: 'railing_metal', position: [0, 4, 1.05], rotationY: -1.5708, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 4, 0],
        axis: [0, 0, 1],
        motorSpeed: 1.2,
        motorForce: 80,
        label: '转子主轴',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '2',
        anchor: [0, 4, 0],
        label: '叶片二',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '3',
        anchor: [0, 4, 0],
        label: '叶片三',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '4',
        anchor: [0, 4, 0],
        label: '叶片四',
      },
    ],
  },

  // 传送带运箱：箱子被导轨约束在带面上，只能沿带长方向滑动
  {
    id: 'conveyor_box',
    name: '传送带运箱',
    description: '箱子被卡在传送带的导轨上，只能沿带面滑动。播放后看带子把它送出去。',
    thumbnail: '📦',
    category: '机械',
    tags: ['传送带', '箱子', '导轨'],
    objects: [
      { defId: 'conveyor', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'cabinet_wood', position: [0, 0.8, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'prismatic',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 0.8, 0],
        axis: [1, 0, 0],
        limits: { min: -1.2, max: 1.2 },
        label: '带面导轨',
      },
    ],
  },

  // 起重机吊钩：吊钩上拴 3 米绳子，下面挂一个箱子
  {
    id: 'crane_hook',
    name: '起重机吊钩',
    description: '起重机吊钩拴着三米长的绳子，下面挂一个箱子。播放后把箱子推出绳长范围试试。',
    thumbnail: '🏗️',
    category: '机械',
    tags: ['起重机', '吊索', '绳长'],
    objects: [
      { defId: 'crane', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'cabinet_wood', position: [1.35, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'rope',
        bodyA: '0',
        bodyB: '1',
        anchor: [1.35, 2, 0],
        length: 3,
        damping: 0.4,
        label: '吊索',
      },
    ],
  },

  // 投石机：混凝土底座 + 电机驱动的抛臂 + 臂端配重
  {
    id: 'catapult',
    name: '投石机',
    description: '底座上的抛臂由电机驱动，带限位。播放后配重砸下来，把臂的另一头甩上天。',
    thumbnail: '🎯',
    category: '机械',
    tags: ['投石机', '抛臂', '配重'],
    objects: [
      { defId: 'foundation_concrete', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'beam_wood', position: [0, 0.6, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'cabinet_wood', position: [-2, 1.4, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 1, 0],
        axis: [0, 0, 1],
        limits: { min: 0, max: 1.2 },
        motorSpeed: 1.5,
        motorForce: 500,
        label: '抛臂轴',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '2',
        anchor: [-2, 1.4, 0],
        label: '配重焊点',
      },
    ],
  },

  // 简易电梯：两根柱子夹着轿厢，只能上下走 4 米
  {
    id: 'elevator',
    name: '简易电梯',
    description: '两根柱子夹着一个轿厢，只能上下走 4 米。播放后在顶层和底层之间反复升降。',
    thumbnail: '🛗',
    category: '结构',
    tags: ['电梯', '轿厢', '垂直限位'],
    objects: [
      { defId: 'pillar_stone', position: [-1.6, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'pillar_stone', position: [1.6, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'cabinet_wood', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'prismatic',
        bodyA: '',
        bodyB: '2',
        anchor: [0, 0.6, 0],
        axis: [0, 1, 0],
        limits: { min: 0, max: 4 },
        label: '轿厢导轨',
      },
    ],
  },

  // 摩天轮：立柱上装大齿轮，四个小座舱焊在轮缘下面
  {
    id: 'ferris_wheel',
    name: '摩天轮',
    description: '立柱上的大齿轮带着四个小座舱慢慢转。播放后看着座舱绕轮缘一整圈。',
    thumbnail: '🎡',
    category: '趣味道具',
    tags: ['摩天轮', '座舱', '匀速转'],
    objects: [
      { defId: 'pillar_stone', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'gear', position: [0, 2.075, 1], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'chair_wood', position: [0.6, 1.1, 1], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'chair_wood', position: [-0.6, 1.1, 1], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'chair_wood', position: [0, 1.1, 1.6], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'chair_wood', position: [0, 1.1, 0.75], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 2.2, 0.6],
        axis: [0, 0, 1],
        motorSpeed: 0.5,
        motorForce: 200,
        label: '主轮轴',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '2',
        anchor: [0.475, 2.1, 1],
        label: '座舱一',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '3',
        anchor: [-0.475, 2.1, 1],
        label: '座舱二',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '4',
        anchor: [0, 2.1, 1.44],
        label: '座舱三',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '5',
        anchor: [0, 2.1, 0.56],
        label: '座舱四',
      },
    ],
  },

  // 喷泉环岛：喷泉池边一圈焊死四个花瓶
  {
    id: 'fountain_ring',
    name: '喷泉环岛',
    description: '喷泉周围一圈摆了四个花瓶，全焊死在池边。播放后撞撞看，它们不会被撞开。',
    thumbnail: '⛲',
    category: '趣味道具',
    tags: ['喷泉', '花瓶', '焊接'],
    objects: [
      { defId: 'fountain', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'vase', position: [0.95, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'vase', position: [-0.95, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'vase', position: [0, 0, 0.95], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'vase', position: [0, 0, -0.95], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'fixed',
        bodyA: '0',
        bodyB: '1',
        anchor: [0.85, 0.2, 0],
        label: '花瓶一',
      },
      {
        type: 'fixed',
        bodyA: '0',
        bodyB: '2',
        anchor: [-0.85, 0.2, 0],
        label: '花瓶二',
      },
      {
        type: 'fixed',
        bodyA: '0',
        bodyB: '3',
        anchor: [0, 0.2, 0.85],
        label: '花瓶三',
      },
      {
        type: 'fixed',
        bodyA: '0',
        bodyB: '4',
        anchor: [0, 0.2, -0.85],
        label: '花瓶四',
      },
    ],
  },

  // 道闸：立柱 + 横杆（绕 Z 抬起，限位到 90 度）+ 杆下挂的牌子
  {
    id: 'traffic_gate',
    name: '道闸',
    description: '立柱上的横杆带限位，只能抬到 90 度。播放后把杆抬起来，放车通过。',
    thumbnail: '🚧',
    category: '结构',
    tags: ['道闸', '横杆', '限位'],
    objects: [
      { defId: 'pillar_stone', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'railing_metal', position: [1.55, 3.6, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'sign_board', position: [2, 2.1, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [0.5, 4.1, 0],
        axis: [0, 0, 1],
        limits: { min: 0, max: 1.57 },
        label: '抬杆轴',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '2',
        anchor: [2, 3.6, 0],
        label: '挡牌焊点',
      },
    ],
  },

  // 跷跷板：小桌当支点，长梁架在中间，两头各压一个箱子
  {
    id: 'balancing_beam',
    name: '跷跷板',
    description: '长梁架在支点中间，两头各压一个箱子。播放后推其中一个箱子，看跷跷板翻哪边。',
    thumbnail: '⚖️',
    category: '趣味道具',
    tags: ['跷跷板', '支点', '平衡'],
    objects: [
      { defId: 'tea_table', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'static' },
      { defId: 'beam_wood', position: [0, 0.45, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'cabinet_wood', position: [2.2, 1.25, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'cabinet_wood', position: [-2.2, 1.25, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'revolute',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 0.85, 0],
        axis: [0, 0, 1],
        limits: { min: -0.4, max: 0.4 },
        label: '支点轴',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '2',
        anchor: [2.2, 1.25, 0],
        label: '右箱焊点',
      },
      {
        type: 'fixed',
        bodyA: '1',
        bodyB: '3',
        anchor: [-2.2, 1.25, 0],
        label: '左箱焊点',
      },
    ],
  },

  // 链条吊灯：三个箱子用绳子一节节串起来，最下面挂吊灯
  {
    id: 'chandelier_chain',
    name: '链条吊灯',
    description: '三个箱子用绳子一节节串起来，最下面挂着吊灯。播放后推最下面的灯，整串一起晃。',
    thumbnail: '⛓️',
    category: '趣味道具',
    tags: ['链条', '吊灯', '多段绳'],
    objects: [
      { defId: 'lamp_ceiling', position: [0, 0, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'cabinet_wood', position: [0, 3.2, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'cabinet_wood', position: [0, 4.8, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
      { defId: 'cabinet_wood', position: [0, 6.4, 0], rotationY: 0, scale: 1, mode: 'dynamic' },
    ],
    joints: [
      {
        type: 'rope',
        bodyA: '0',
        bodyB: '1',
        anchor: [0, 3.1, 0],
        length: 0.4,
        damping: 0.5,
        label: '第一节吊索',
      },
      {
        type: 'rope',
        bodyA: '1',
        bodyB: '2',
        anchor: [0, 4.6, 0],
        length: 0.5,
        damping: 0.5,
        label: '第二节吊索',
      },
      {
        type: 'rope',
        bodyA: '2',
        bodyB: '3',
        anchor: [0, 6.2, 0],
        length: 0.5,
        damping: 0.5,
        label: '第三节吊索',
      },
      {
        type: 'rope',
        bodyA: '',
        bodyB: '3',
        anchor: [0, 7.7, 0],
        length: 0.5,
        damping: 0.5,
        label: '吊顶索',
      },
    ],
  },
];
