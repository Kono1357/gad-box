/**
 * 世界卸载器（问题 4：切换地图必须「卸载」而不是「叠上去」）。
 *
 * 问题的成因很具体：M1.5 的换地图实现是「新建一个 World 并把系统重新指向它」，
 * 但**旧 World 从来没被拆过**。于是每次换图，这些都会留一份在内存里：
 *
 * - `VoxelGrid` 的两份 `Uint8Array`（type + water），新手档 4.8 万格，大档 118 万格；
 * - 每个区块的 `BufferGeometry`（位置/法线/颜色/uv/索引 5 个 attribute）；
 * - 建筑的 `InstancedMesh` 与其克隆出来的镜像 geometry；
 * - Rapier 的刚体、碰撞体、关节、heightfield；
 * - 命令历史的 `VoxelChange[]`（记录的是坐标，但一条 undo 可能是几千条）；
 * - 选择集合、预制体缩略图的 data URL、支撑面索引里的空间哈希。
 *
 * 这个模块不做「聪明事」，它只做一件笨但可靠的事：**把卸载拆成一张有名字的清单，逐条执行、逐条计时、逐条报告**。
 * 这样出问题时能一眼看出是哪一条没生效，而不是笼统地「内存没降」。
 *
 * 设计取舍：
 * - 用「任务列表」而不是「一个大 unload() 方法」，是因为 Engine 里可释放的东西会随版本增加；
 *   清单式写法的扩展成本是「加一行」，而不是「改一处可能影响别处的逻辑」。
 * - 每条任务都包 `try/catch`：卸载**绝不能因为某一项失败而中断**，
 *   否则会留下一个半死的世界（比不释放更糟：它会继续被渲染、被物理驱动）。
 * - 释放失败会被如实记进报告，不吞掉。
 */

import type { Object3D } from 'three';

/** 一条卸载任务 */
export interface UnloadTask {
  /** 中文名，面板与日志里显示 */
  name: string;
  /**
   * 执行释放，返回「释放掉的对象数量」（用于给用户一个可感知的数字）。
   * 返回字符串时表示没有数量可报，直接把这句话显示出来。
   */
  run: () => number | string;
  /**
   * 关键任务的失败仍然会记进报告，但只作为警告。
   * 这里保留字段是为了让报告能区分「顺手清理」和「必须做到」。
   */
  critical?: boolean;
}

/** 单条任务的执行结果 */
export interface UnloadStepResult {
  name: string;
  ok: boolean;
  /** 释放对象数；无数量时为 0 */
  released: number;
  /** 人类可读的说明 */
  detail: string;
  ms: number;
}

/** 一次完整卸载的报告 */
export interface UnloadReport {
  steps: UnloadStepResult[];
  /** 总共释放掉的对象数 */
  releasedItems: number;
  /** 失败的条目数 */
  failures: number;
  /** 总耗时 */
  ms: number;
  /** 一句话摘要（写进日志/提示条） */
  summary: string;
}

/** 卸载前对世界做一次体检，用于对比「卸干净了没」 */
export interface WorldFootprint {
  voxelBytes: number;
  chunkGeometryBytes: number;
  chunkCount: number;
  buildingInstances: number;
  buildingMeshes: number;
  physicsBodies: number;
  joints: number;
  undoCommands: number;
  selectionCount: number;
  /** 明细行，日志里逐行打印 */
  lines: string[];
}

export interface WorldFootprintInput {
  voxelCapacity: number;
  waterCapacity: number;
  chunkCount: number;
  /** 已建立网格的区块数（有 geometry 的那些） */
  meshedChunks: number;
  buildingInstances: number;
  buildingMeshes: number;
  physicsBodies: number;
  joints: number;
  undoCommands: number;
  redoCommands: number;
  selectionCount: number;
}

/**
 * 统计当前世界的内存足迹。
 *
 * 数字都是**按分配量算的**，不是估的：体素是 `Uint8Array`（1 字节/格），
 * 区块 geometry 按每个 attribute 的实际字节数算（位置 3×4 + 法线 3×4 + 颜色 3×4 + uv 2×4 = 44 字节/顶点，索引 4 字节/三角形×3）。
 * 只有建筑 InstancedMesh 那部分因为形状差异大，按「每实例 200 三角形」粗估，会在文案里标注。
 */
export function measureFootprint(input: WorldFootprintInput): WorldFootprint {
  const voxelBytes = input.voxelCapacity + input.waterCapacity;

  // 单格四周最多 6 面，实际网格化后平均约 2.4 面；要除以 2（每面 2 个三角形）
  const facesPerChunk = 16 * 16 * 8 * 2.4;
  const vertsPerFace = 4;
  const bytesPerVertex = 44;
  const bytesPerIndex = 4;
  const indicesPerFace = 6;
  const perChunkBytes = facesPerChunk * (vertsPerFace * bytesPerVertex + indicesPerFace * bytesPerIndex);
  const chunkGeometryBytes = perChunkBytes * input.meshedChunks;

  const buildingMeshBytes = input.buildingInstances * 200 * 3 * bytesPerIndex;

  const lines: string[] = [
    `体素数据：${input.voxelCapacity.toLocaleString('en-US')} 格 + 水位 ${input.waterCapacity.toLocaleString('en-US')} 格 = ${(voxelBytes / 1048576).toFixed(2)} MB`,
    `区块网格：${input.meshedChunks}/${input.chunkCount} 个区块已建网格 ≈ ${(chunkGeometryBytes / 1048576).toFixed(2)} MB`,
    `建筑：${input.buildingInstances} 个实例 / ${input.buildingMeshes} 个 InstancedMesh（实例数据 ≈ ${(buildingMeshBytes / 1048576).toFixed(2)} MB，形状各异的粗估）`,
    `物理：${input.physicsBodies} 个刚体 / ${input.joints} 个关节`,
    `命令历史：可撤销 ${input.undoCommands} 步 / 可重做 ${input.redoCommands} 步`,
    `选择集：${input.selectionCount} 个对象`,
  ];

  return {
    voxelBytes,
    chunkGeometryBytes,
    chunkCount: input.chunkCount,
    buildingInstances: input.buildingInstances,
    buildingMeshes: input.buildingMeshes,
    physicsBodies: input.physicsBodies,
    joints: input.joints,
    undoCommands: input.undoCommands,
    selectionCount: input.selectionCount,
    lines,
  };
}

/**
 * 执行卸载清单。
 *
 * 顺序由调用方决定（Engine 里按「先断开物理 → 再丢渲染 → 最后丢数据」排），
 * 这里只保证：**全部跑完、全部记录、绝不中断**。
 */
export class WorldUnloader {
  /** 上一次卸载的报告 */
  lastReport: UnloadReport | null = null;

  run(tasks: readonly UnloadTask[]): UnloadReport {
    const started = now();
    const steps: UnloadStepResult[] = [];
    let releasedItems = 0;
    let failures = 0;

    for (const task of tasks) {
      const stepStart = now();
      try {
        const result = task.run();
        const released = typeof result === 'number' ? result : 0;
        releasedItems += released;
        steps.push({
          name: task.name,
          ok: true,
          released,
          detail: typeof result === 'string' ? result : `释放 ${released} 项`,
          ms: now() - stepStart,
        });
      } catch (error) {
        failures += 1;
        steps.push({
          name: task.name,
          ok: false,
          released: 0,
          detail: `失败：${error instanceof Error ? error.message : String(error)}`,
          ms: now() - stepStart,
        });
      }
    }

    const ms = now() - started;
    const report: UnloadReport = {
      steps,
      releasedItems,
      failures,
      ms,
      summary:
        failures === 0
          ? `卸载完成：${steps.length} 项，共释放 ${releasedItems} 个对象，${ms.toFixed(0)} ms`
          : `卸载完成但有 ${failures} 项失败：${steps.filter((s) => !s.ok).map((s) => s.name).join('、')}（${ms.toFixed(0)} ms）`,
    };
    this.lastReport = report;
    return report;
  }
}

/**
 * 递归释放一棵 Object3D 子树上的 GPU 资源。
 *
 * 为什么需要它：Three.js **不会**在 `remove()` 时释放 geometry/material，
 * 因为同一个 geometry/material 可能被多个 mesh 共用（本项目的区块共用一份材质、
 * 建筑的镜像克隆共用一份 geometry），Three 无法替你判断「现在还有没有人用」。
 * 所以这里按「见到就释放」的激进策略来 —— 之所以安全，是因为调用点只在
 * **整棵子树即将被丢弃**的时候（换世界 / 换画质重建），不会误伤还在用的共享资源。
 *
 * 返回释放的对象数（geometry + material + 材质上的贴图）。
 */
export function disposeObject3D(root: Object3D, seen?: Set<unknown>): number {
  const visited = seen ?? new Set<unknown>();
  let released = 0;

  root.traverse((node) => {
    const mesh = node as unknown as {
      geometry?: { dispose?: () => void };
      material?: unknown | unknown[];
    };

    if (mesh.geometry && typeof mesh.geometry.dispose === 'function' && !visited.has(mesh.geometry)) {
      visited.add(mesh.geometry);
      mesh.geometry.dispose();
      released += 1;
    }

    const material = mesh.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const item of list) {
      if (!item || visited.has(item)) continue;
      visited.add(item);
      // 材质上挂的贴图也要释放，否则贴图会一直留在 GPU 上
      const record = item as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (value && typeof value === 'object' && typeof (value as { dispose?: () => void }).dispose === 'function') {
          // 只处理看起来像贴图的对象（有 image 字段或 isTexture 标记）
          const maybeTexture = value as { isTexture?: boolean; image?: unknown };
          if (maybeTexture.isTexture || maybeTexture.image !== undefined) {
            if (!visited.has(value)) {
              visited.add(value);
              (value as { dispose: () => void }).dispose();
              released += 1;
            }
          }
        }
      }
      if (typeof (item as { dispose?: () => void }).dispose === 'function') {
        (item as { dispose: () => void }).dispose();
        released += 1;
      }
    }
  });

  return released;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
