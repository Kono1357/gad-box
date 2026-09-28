/**
 * 流体与沙土教学关卡（M4 第二部分 · 第 8 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 六个关卡与它们真正想教的东西
 * ────────────────────────────────────────────────────────────
 * | 关卡 | 教什么 | 判定依据 |
 * |---|---|---|
 * | 1 水流向低处 | 重力与水会自己找平 | 玩家倒的水在若干秒后**铺开**到一定跨度、且不再有大速度 |
 * | 2 浮力与船 | 阿基米德原理（密度比） | 世界里出现"浸没比例 > 0.3 的物体"且它**没有继续下沉** |
 * | 3 水压与闸门 | 冻结区域可以当闸门 | 玩家造出冻结区，并且**有粒子停在它的一侧** |
 * | 4 沙崩 | 安息角与连锁 | 发生一次规模 ≥ 阈值的一次沙崩 |
 * | 5 泥流 | 饱和沙 + 流水 = 侵蚀/搬运 | 出现"侵蚀与沉积同时发生"的那一帧 |
 * | 6 洪水 | 大水量 + 耦合（把东西冲走） | 大水量下**动态物体被推动**（速度超过阈值） |
 *
 * ────────────────────────────────────────────────────────────
 * 为什么判定用"快照函数"而不是直接读引擎
 * ────────────────────────────────────────────────────────────
 * 每个关卡的判定都是一个**纯函数** `(snapshot) => boolean`，快照由 Engine 每帧组装。
 * 于是：
 * - 断言里可以喂人造快照，精确验证"什么条件下算通关"（不必真的倒水、真的推箱子）；
 * - 关卡逻辑不与引擎耦合，改引擎不会悄悄改掉关卡难度。
 *
 * ⚠ 如实说明：这些关卡是"引导"而不是"考试"。判定阈值取得很宽
 * （例如"铺开 3 米"而不是"精确达到 15° 安息角"），因为玩家不该为了通关
 * 去精确操作一个带离散近似的模拟。它们的目标是"让人发现某个功能"。
 */

import type { FluidTool } from '../fluid/FluidEditor';
import type { SandTool } from '../sand/SandPhysics';

/** 一帧的世界快照（Engine 组装；断言里可以造） */
export interface TutorialSnapshot {
  /** 时间（毫秒，用于"持续了多少秒"的判定） */
  nowMs: number;
  /** 流体粒子数 */
  fluidParticles: number;
  /** 流体的水平铺开跨度（米） */
  fluidSpread: number;
  /** 流体平均速度（米/秒） */
  fluidSpeed: number;
  /** 冻结区域数量 */
  frozenRegions: number;
  /** 冻结区域里静止的粒子数 */
  frozenParticles: number;
  /** 浸没中的动态物体数（浸没比例 > 0.3） */
  submergedBodies: number;
  /** 其中正在下沉的物体数 */
  sinkingBodies: number;
  /** 被水推动的物体数（速度 > 0.3 m/s 且浸没过） */
  pushedBodies: number;
  /** 最近一次沙崩的规模（格） */
  lastCollapseCells: number;
  /** 累计沙崩次数 */
  collapseCount: number;
  /** 上一帧侵蚀了几格沙 */
  erodedCells: number;
  /** 上一帧沉积了几格沙 */
  depositedCells: number;
  /** 玩家用过哪些流体工具 */
  usedFluidTools: readonly FluidTool[];
  /** 玩家用过哪些沙土工具 */
  usedSandTools: readonly SandTool[];
}

export interface TutorialLevel {
  id: string;
  name: string;
  /** 一句话说明"这一关要干什么" */
  goal: string;
  /** 通关条件的中文说明（面板上显示，玩家能自己对照） */
  successHint: string;
  /** 建议用的工具（提示玩家按哪个键） */
  suggestedTools: readonly string[];
  /** 判定：给定快照，是否已通关 */
  check(snapshot: TutorialSnapshot, elapsedMs: number): boolean;
  /** 当前进度提示（没通关时显示；返回 null 表示"还没开始做"） */
  progress?(snapshot: TutorialSnapshot, elapsedMs: number): string | null;
}

export interface TutorialState {
  levelIndex: number;
  /** 这一关已经开始了多久（毫秒） */
  elapsedMs: number;
  /** 是否已通关 */
  completed: boolean;
  /** 是否已全部通关 */
  allDone: boolean;
  /** 当前提示（中文） */
  hint: string;
}

/** 关卡 1 要求"静置"多久（毫秒）：水倒下来之后要给它时间铺开 */
const SETTLE_WINDOW_MS = 2500;
/** 关卡 2 要求"浮住不动"多久 */
const FLOAT_WINDOW_MS = 2000;

export const TUTORIAL_LEVELS: readonly TutorialLevel[] = [
  {
    id: 'flow-downhill',
    name: '水流向低处',
    goal: '用「泼水」在地面上倒一摊水，看它自己铺开、找平',
    successHint: '水铺开到 3 米以上、并且安静下来（平均速度 < 0.5 米/秒）持续 2.5 秒',
    suggestedTools: ['泼水（FluidEditor.pour）'],
    check: (snapshot, elapsedMs) =>
      snapshot.fluidParticles >= 60 &&
      snapshot.fluidSpread >= 3 &&
      snapshot.fluidSpeed < 0.5 &&
      elapsedMs >= SETTLE_WINDOW_MS,
    progress: (snapshot, elapsedMs) => {
      if (snapshot.fluidParticles < 60) return `还需要更多水（现在 ${snapshot.fluidParticles} 个粒子，目标 60）`;
      if (snapshot.fluidSpread < 3) return `水还没铺开（现在 ${snapshot.fluidSpread.toFixed(1)} 米，目标 3 米）`;
      if (snapshot.fluidSpeed >= 0.5) return `水还在动（${snapshot.fluidSpeed.toFixed(2)} 米/秒），等它安静下来`;
      return `快了：再保持 ${((SETTLE_WINDOW_MS - elapsedMs) / 1000).toFixed(1)} 秒`;
    },
  },
  {
    id: 'buoyancy',
    name: '浮力与船',
    goal: '倒一池水，往里面放一个物体，看它是浮起来还是沉下去',
    successHint: '有物体浸没在水里（浸没比例 > 0.3）并且**不再继续下沉**，持续 2 秒',
    suggestedTools: ['泼水', '建筑放置（放一个木箱）'],
    check: (snapshot, elapsedMs) =>
      snapshot.submergedBodies > 0 && snapshot.sinkingBodies === 0 && elapsedMs >= FLOAT_WINDOW_MS,
    progress: (snapshot) => {
      if (snapshot.fluidParticles < 100) return '先倒一池水（至少 100 个粒子）';
      if (snapshot.submergedBodies === 0) return '还没有物体浸在水里 —— 往水里放一个东西';
      if (snapshot.sinkingBodies > 0) return `有 ${snapshot.sinkingBodies} 个物体正在下沉（它比水重），换一个轻一点的试试`;
      return '物体浮住了，再等一会儿确认它稳定';
    },
  },
  {
    id: 'gate',
    name: '水压与闸门',
    goal: '用「冻结」在水里圈一块区域，做成一道闸门',
    successHint: '造出冻结区域，并且有 20 个以上粒子停在它里面（被冻住）',
    suggestedTools: ['泼水', '冻结'],
    check: (snapshot) => snapshot.frozenRegions > 0 && snapshot.frozenParticles >= 20,
    progress: (snapshot) => {
      if (snapshot.frozenRegions === 0) return '还没造冻结区 —— 用「冻结」工具在水里点一下';
      if (snapshot.frozenParticles < 20) return `冻结区里只有 ${snapshot.frozenParticles} 个粒子（目标 20）—— 对着有水的地方点`;
      return null;
    },
  },
  {
    id: 'sand-collapse',
    name: '沙崩',
    goal: '用「堆沙」堆一个高沙柱，看它塌下来',
    successHint: '发生一次规模 ≥ 12 格的沙崩',
    suggestedTools: ['堆沙', '让全部沙重新检查稳定性'],
    check: (snapshot) => snapshot.collapseCount > 0 && snapshot.lastCollapseCells >= 12,
    progress: (snapshot) => {
      if (snapshot.usedSandTools.length === 0) return '还没用过沙土工具 —— 切到「沙土」堆一堆沙';
      if (snapshot.collapseCount === 0) return '还没发生沙崩 —— 堆高一点（堆沙高度滑到 8 格以上），或者点「让全部沙重新检查稳定性」';
      return `刚发生了一次 ${snapshot.lastCollapseCells} 格的沙崩（目标 ≥ 12）`;
    },
  },
  {
    id: 'mudflow',
    name: '泥流',
    goal: '把沙弄湿，再用急流冲它 —— 看沙被冲走又在远处淤积',
    successHint: '同一帧里既有沙被冲走、又有沙淤积',
    suggestedTools: ['堆沙', '湿沙', '泼水', '抽水（制造急流）'],
    check: (snapshot) => snapshot.erodedCells > 0 && snapshot.depositedCells > 0,
    progress: (snapshot) => {
      if (!snapshot.usedSandTools.includes('wet')) return '先用「湿沙」把沙弄湿（干沙不会被水冲走）';
      if (snapshot.erodedCells === 0) return '还没有沙被冲走 —— 用水流直接冲湿沙（水要够快：用「加水」或「泼水」制造急流）';
      if (snapshot.depositedCells === 0) return '沙被冲走了，但还没淤积 —— 让水流慢下来（下游、或者用「抽水」减少水量）';
      return null;
    },
  },
  {
    id: 'flood',
    name: '洪水',
    goal: '倒大量水，看它把箱子、船这类东西冲得动',
    successHint: '有浸没的物体被水流推动（速度 > 0.3 米/秒）',
    suggestedTools: ['加水（持续大量）', '建筑放置'],
    check: (snapshot) => snapshot.pushedBodies > 0,
    progress: (snapshot) => {
      if (snapshot.fluidParticles < 400) return `水量还不够（现在 ${snapshot.fluidParticles} 个粒子，洪水至少要 400）—— 用「加水」按住不放`;
      if (snapshot.submergedBodies === 0) return '水里还没有物体 —— 放个箱子进水';
      if (snapshot.pushedBodies === 0) return '物体还没被推动 —— 水得流动起来（在水位高的地方继续加水）';
      return null;
    },
  },
];

export class FluidSandTutorial {
  private index = 0;
  private elapsed = 0;
  private done = false;
  /** 每一关的完成记录（面板显示"6 关过了几关"） */
  private readonly completed = new Set<string>();
  private lastHint = '';

  get level(): TutorialLevel {
    return TUTORIAL_LEVELS[Math.min(this.index, TUTORIAL_LEVELS.length - 1)]!;
  }

  get state(): TutorialState {
    return {
      levelIndex: this.index,
      elapsedMs: this.elapsed,
      completed: this.done,
      allDone: this.completed.size >= TUTORIAL_LEVELS.length,
      // 还没有跑过任何一帧时，提示用"这一关的通关条件"兜底 ——
      // 面板在玩家刚打开教学时不该是一片空白（那个空白看起来像"教学坏了"）
      hint: this.lastHint || this.level.successHint || this.level.successHint,
    };
  }

  get completedCount(): number {
    return this.completed.size;
  }

  /** 从第几关开始（面板的"重新开始"用） */
  reset(index = 0): void {
    this.index = Math.max(0, Math.min(TUTORIAL_LEVELS.length - 1, index));
    this.elapsed = 0;
    this.done = false;
    this.lastHint = '';
  }

  /** 跳到下一关（当前关通关时自动调用；玩家也可以手动跳） */
  next(): boolean {
    if (!this.done && this.index < TUTORIAL_LEVELS.length - 1) {
      // 手动跳过也算"过了"（但不计入 completed —— 那会虚报进度）
      this.index += 1;
      this.elapsed = 0;
      this.done = false;
      return true;
    }
    if (this.index < TUTORIAL_LEVELS.length - 1) {
      this.index += 1;
      this.elapsed = 0;
      this.done = false;
      return true;
    }
    return false;
  }

  /**
   * 每帧推进。
   *
   * @returns 当前状态（含中文提示）
   */
  update(snapshot: TutorialSnapshot, dtMs: number): TutorialState {
    if (this.done) {
      this.lastHint = `✅ 已通关：${this.level.successHint}`;
      return this.state;
    }
    this.elapsed += Math.max(0, dtMs);
    const level = this.level;
    if (level.check(snapshot, this.elapsed)) {
      this.done = true;
      this.completed.add(level.id);
      this.lastHint = `✅ 通关：${level.name}`;
      return this.state;
    }
    const progress = level.progress?.(snapshot, this.elapsed) ?? null;
    this.lastHint = progress ?? level.successHint;
    return this.state;
  }
}
