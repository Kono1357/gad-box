import { SAVE_CONFIG } from '../config';
import { AIR } from '../data/voxelTypes';
import type { WorldSizeId } from '../worldSize';
import type { BuildingSystem } from '../building/BuildingSystem';
import { getBuildingDef } from '../data/buildingCatalog';
import type { BuildingInstance, Group, MirrorAxis, PhysicsMode } from '../building/types';
import type { GroupSystem } from '../group/GroupSystem';
import { Chunk } from '../voxel/Chunk';
import type { VoxelGrid } from '../voxel/VoxelGrid';

/** 存档里的相机状态 */
export interface SavedCamera {
  position: [number, number, number];
  target: [number, number, number];
  radius: number;
  theta: number;
  phi: number;
}

/** 压缩后的字节块 */
export interface PackedBytes {
  /** rle = 游程编码；raw = 原样 */
  e: 'rle' | 'raw';
  d: string;
}

export interface SavedChunk {
  cx: number;
  cz: number;
  voxels: PackedBytes;
  /** 只有含水时才存 */
  water?: PackedBytes;
}

export interface SavedBuilding {
  id: number;
  defId: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  isStatic: boolean;
  /** v3：刚体模式（静态摆放 / 会掉下来） */
  physicsMode?: PhysicsMode;
  /** v3：所属分组 */
  groupId?: string;
  /** v3：镜像标记 */
  mirror?: MirrorAxis;
}

/** 玩家设置（笔刷 + 物理开关），跟着存档一起走 */
export interface SavedSettings {
  brushMode: string;
  brushShape: string;
  brushRadius: number;
  brushStrength: number;
  brushFalloff: string;
  brushDensity: number;
  brushDirection: string;
  brushMaterial: string;
  waterEnabled: boolean;
  waterSpeed: number;
  waterDispersion: number;
  sandEnabled: boolean;
  sandAngle: number;
  supportEnabled: boolean;
  supportCantilever: number;
}

/** 当前存档格式（v2） */
export interface SaveData {
  version: number;
  savedAt: number;
  seed: number;
  /** 来源参考地图（自定义世界为 null） */
  mapId: string | null;
  worldSize: WorldSizeId;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  simTime: number;
  stepCount: number;
  camera: SavedCamera;
  settings: SavedSettings;
  chunks: SavedChunk[];
  buildings: SavedBuilding[];
  /** v3：分组数据 */
  groups?: Group[];
}

/** M1 的旧格式（只读兼容） */
interface LegacySaveData {
  version: number;
  seed: number;
  savedAt?: number;
  simTime?: number;
  stepCount?: number;
  camera?: SavedCamera;
  chunks: Array<{ cx: number; cz: number; data: string }>;
}

export interface SaveResult {
  ok: boolean;
  message: string;
  bytes?: number;
  ms?: number;
}

export interface SaveContext {
  getGrid(): VoxelGrid;
  getWorldInfo(): { seed: number; sizeId: WorldSizeId; mapId: string | null };
  /**
   * 需要换世界（尺寸不一致）时由 Engine 重建，返回新的网格。
   * 尺寸相同则直接返回当前网格。
   */
  recreateWorld(size: WorldSizeId, seed: number, mapId: string | null): VoxelGrid;
  buildings: BuildingSystem;
  /** 分组系统（v3 起参与存档） */
  groups: GroupSystem;
  getSettings(): SavedSettings;
  applySettings(settings: SavedSettings): void;
  getCamera(): SavedCamera;
  applyCamera(camera: SavedCamera): void;
  getSimTime(): number;
  getStepCount(): number;
  /** 世界被替换后的收尾：清空撤销历史、重建网格、提示 UI */
  onWorldReplaced(source: string): void;
}

// ---------------------------------------------------------------- 字节压缩

/**
 * 游程编码：连续相同的字节压成 [值, 次数]。
 *
 * 对体素数据特别有效：地下是大片相同的石头、天上是大片空气，
 * 一张 128×32×128 的地图能从 512 KB 压到几十 KB，
 * 于是 localStorage 存得下、导出的 JSON 也不至于爆掉。
 */
export function rleEncode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const value = bytes[index]!;
    let run = 1;
    while (index + run < bytes.length && bytes[index + run] === value && run < 255) run++;
    out.push(value, run);
    index += run;
  }
  return Uint8Array.from(out);
}

export function rleDecode(data: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let cursor = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    const value = data[i]!;
    const run = data[i + 1]!;
    for (let j = 0; j < run && cursor < expectedLength; j++) out[cursor++] = value;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const blockSize = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += blockSize) {
    const slice = bytes.subarray(i, Math.min(i + blockSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 打包：RLE 更小就用 RLE，否则退回原样（保证不吃亏） */
export function packBytes(bytes: Uint8Array): PackedBytes {
  const encoded = rleEncode(bytes);
  if (encoded.length < bytes.length) {
    return { e: 'rle', d: bytesToBase64(encoded) };
  }
  return { e: 'raw', d: bytesToBase64(bytes) };
}

export function unpackBytes(packed: PackedBytes, expectedLength: number): Uint8Array {
  const bytes = base64ToBytes(packed.d);
  if (packed.e === 'rle') return rleDecode(bytes, expectedLength);
  return bytes.length === expectedLength ? bytes : bytes.subarray(0, expectedLength);
}

/**
 * 存档系统（v2）。
 *
 * 相比 M1 增加的内容：
 * - **水量**（每格 0~255）—— 水少了/多了必须能存下来，否则"填满容器"就白做了；
 * - **建筑实例** —— 玩家摆的房子要能存；
 * - **世界尺寸与来源地图** —— 支持 64/128/256 三档与参考地图；
 * - **玩家设置** —— 笔刷参数、物理开关一起存，读档后手感不变；
 * - **RLE 压缩** —— 否则大型世界存档撑爆 localStorage 的 5 MB 上限；
 * - **v1 兼容读取** —— 老的 `god-sandbox-save-v1` 仍能载入（缺的水与建筑按空处理）。
 */
export class SaveSystem {
  static readonly STORAGE_KEY = SAVE_CONFIG.storageKey;
  static readonly LEGACY_STORAGE_KEY = SAVE_CONFIG.legacyStorageKey;

  private autoSaveEnabled = true;
  private lastSaveAt = 0;
  private lastEditAt = 0;
  private observedRevision = -1;
  private lastAutoSaveMessage = '';

  constructor(private readonly context: SaveContext) {
    this.observedRevision = context.getGrid().editRevision;
  }

  // ------------------------------------------------------------ 自动保存

  get isAutoSaveEnabled(): boolean {
    return this.autoSaveEnabled;
  }

  setAutoSaveEnabled(enabled: boolean): void {
    this.autoSaveEnabled = enabled;
    if (enabled) {
      this.lastEditAt = performance.now();
      this.observedRevision = -1;
    }
  }

  get autoSaveMessage(): string {
    return this.lastAutoSaveMessage;
  }

  /** 每帧调用；内部自带节流 */
  tick(): void {
    if (!this.autoSaveEnabled) return;
    const now = performance.now();
    const revision = this.context.getGrid().editRevision;

    if (revision !== this.observedRevision) {
      this.observedRevision = revision;
      this.lastEditAt = now;
      return;
    }

    const idle = now - this.lastEditAt;
    const sinceSave = now - this.lastSaveAt;
    if (idle >= SAVE_CONFIG.autoSaveDebounceMs || sinceSave >= SAVE_CONFIG.autoSaveIntervalMs) {
      const result = this.saveToStorage();
      this.lastAutoSaveMessage = result.ok
        ? `已自动保存（${((result.bytes ?? 0) / 1024).toFixed(0)} KB）`
        : result.message;
    }
  }

  // ------------------------------------------------------------ 序列化

  serialize(): SaveData {
    const grid = this.context.getGrid();
    const info = this.context.getWorldInfo();
    const chunks: SavedChunk[] = [];

    grid.forEachChunk((chunk) => {
      if (isEmptyChunk(chunk)) return;
      const entry: SavedChunk = {
        cx: chunk.cx,
        cz: chunk.cz,
        voxels: packBytes(chunk.voxels),
      };
      if (chunk.hasWater()) entry.water = packBytes(chunk.water);
      chunks.push(entry);
    });

    return {
      version: SAVE_CONFIG.version,
      savedAt: Date.now(),
      seed: info.seed,
      mapId: info.mapId,
      worldSize: info.sizeId,
      sizeX: grid.sizeX,
      sizeY: grid.sizeY,
      sizeZ: grid.sizeZ,
      simTime: this.context.getSimTime(),
      stepCount: this.context.getStepCount(),
      camera: this.context.getCamera(),
      settings: this.context.getSettings(),
      chunks,
      buildings: this.context.buildings.toSaveData(),
      groups: this.context.groups.toSaveData(),
    };
  }

  // ------------------------------------------------------------ localStorage

  saveToStorage(): SaveResult {
    const started = performance.now();
    try {
      const data = this.serialize();
      const text = JSON.stringify(data);
      localStorage.setItem(SAVE_CONFIG.storageKey, text);
      this.lastSaveAt = performance.now();
      this.observedRevision = this.context.getGrid().editRevision;
      return {
        ok: true,
        message: `已保存到本地（${data.chunks.length} 区块 / ${data.buildings.length} 建筑 / ${(text.length / 1024).toFixed(0)} KB）`,
        bytes: text.length,
        ms: performance.now() - started,
      };
    } catch (error) {
      const isQuota =
        error instanceof Error &&
        (error.name === 'QuotaExceededError' || error.message.toLowerCase().includes('quota'));
      return {
        ok: false,
        message: isQuota
          ? '本地存储空间不足（约 5MB），请改用「导出 JSON」'
          : `保存失败：${error instanceof Error ? error.message : String(error)}`,
        ms: performance.now() - started,
      };
    }
  }

  loadFromStorage(): SaveResult {
    let text: string | null = null;
    let source = '本地存档';
    try {
      text = localStorage.getItem(SAVE_CONFIG.storageKey);
      if (!text) {
        // 回退读 M1 的旧键
        text = localStorage.getItem(SAVE_CONFIG.legacyStorageKey);
        if (text) source = 'M1 旧存档';
      }
    } catch (error) {
      return { ok: false, message: `读取本地存储失败：${String(error)}` };
    }
    if (!text) return { ok: false, message: '本地没有存档' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: '本地存档已损坏（JSON 解析失败）' };
    }
    return this.applySaveData(parsed, source);
  }

  hasStorageSave(): boolean {
    try {
      return (
        localStorage.getItem(SAVE_CONFIG.storageKey) !== null ||
        localStorage.getItem(SAVE_CONFIG.legacyStorageKey) !== null
      );
    } catch {
      return false;
    }
  }

  clearStorage(): SaveResult {
    try {
      localStorage.removeItem(SAVE_CONFIG.storageKey);
      localStorage.removeItem(SAVE_CONFIG.legacyStorageKey);
      return { ok: true, message: '本地存档已删除' };
    } catch (error) {
      return { ok: false, message: `删除失败：${String(error)}` };
    }
  }

  storageSize(): number {
    try {
      return (
        (localStorage.getItem(SAVE_CONFIG.storageKey)?.length ?? 0) +
        (localStorage.getItem(SAVE_CONFIG.legacyStorageKey)?.length ?? 0)
      );
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------ 文件

  exportToFile(): SaveResult {
    try {
      const data = this.serialize();
      const text = JSON.stringify(data);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `god-sandbox-${data.seed}-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return { ok: true, message: `已导出 JSON（${(text.length / 1024).toFixed(0)} KB）`, bytes: text.length };
    } catch (error) {
      return { ok: false, message: `导出失败：${String(error)}` };
    }
  }

  async importFromFile(file: File): Promise<SaveResult> {
    try {
      const text = await file.text();
      return this.applySaveData(JSON.parse(text), `文件 ${file.name}`);
    } catch (error) {
      return {
        ok: false,
        message: `导入失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ------------------------------------------------------------ 应用

  applySaveData(raw: unknown, source: string): SaveResult {
    const started = performance.now();
    if (!raw || typeof raw !== 'object') return { ok: false, message: '存档内容不是对象' };

    const anyData = raw as Partial<SaveData> & Partial<LegacySaveData>;
    const version = typeof anyData.version === 'number' ? anyData.version : 0;
    if (version === 0) return { ok: false, message: '存档缺少 version 字段' };
    if (version > SAVE_CONFIG.version) {
      return { ok: false, message: `存档版本 ${version} 高于当前程序支持的 ${SAVE_CONFIG.version}` };
    }
    if (!Array.isArray(anyData.chunks)) return { ok: false, message: '存档缺少 chunks 数据' };

    // 1) 决定世界尺寸：v1 固定 128×32×128；v2 从存档读
    const sizeId: WorldSizeId =
      version >= 2 && anyData.worldSize ? (anyData.worldSize as WorldSizeId) : 'standard';
    const seed = typeof anyData.seed === 'number' ? anyData.seed : 0;
    const mapId = version >= 2 ? (anyData.mapId ?? null) : null;

    const grid = this.context.recreateWorld(sizeId, seed, mapId);
    grid.clear(AIR);

    // 2) 写回区块
    let restoredChunks = 0;
    let restoredWater = 0;
    for (const entry of anyData.chunks) {
      if (!entry || typeof entry.cx !== 'number' || typeof entry.cz !== 'number') continue;
      const chunk = grid.getChunk(entry.cx, entry.cz);
      if (!chunk) continue;

      if (version >= 2) {
        const modern = entry as SavedChunk;
        if (!modern.voxels) continue;
        chunk.voxels.set(unpackBytes(modern.voxels, chunk.voxels.length));
        if (modern.water) {
          const water = unpackBytes(modern.water, chunk.water.length);
          chunk.water.set(water);
          restoredWater++;
        } else {
          chunk.water.fill(0);
        }
      } else {
        // v1：单块 base64 原始体素，且没有水量层
        const legacy = entry as { data?: string };
        if (typeof legacy.data !== 'string') continue;
        const bytes = base64ToBytes(legacy.data);
        if (bytes.length !== chunk.voxels.length) continue;
        chunk.voxels.set(bytes);
        chunk.water.fill(0);
      }
      restoredChunks++;
    }

    // 3) 建筑
    this.context.buildings.clear();
    let restoredBuildings = 0;
    if (version >= 2 && Array.isArray(anyData.buildings)) {
      for (const saved of anyData.buildings as SavedBuilding[]) {
        if (!saved || typeof saved.defId !== 'string') continue;
        if (!getBuildingDef(saved.defId)) continue; // 未知模型直接跳过，不报错中断
        const instance: BuildingInstance = {
          id: saved.id,
          defId: saved.defId,
          position: [...saved.position] as [number, number, number],
          rotationY: saved.rotationY ?? 0,
          scale: saved.scale ?? 1,
          isStatic: saved.isStatic ?? true,
          // v2 及更早的存档没有这些字段：缺失时按"静态 + 无分组 + 不镜像"处理
          physicsMode: saved.physicsMode ?? 'static',
          groupId: undefined,
          mirror: saved.mirror ?? 'none',
        };
        const def = getBuildingDef(saved.defId)!;
        instance.size = [...def.size] as [number, number, number];
        instance.color = def.color;
        instance.name = def.name;
        this.context.buildings.restore([instance]);
        restoredBuildings++;
      }
    }

    // 4) 分组（v3 起；更早的存档没有分组数据，直接清空即可）
    this.context.groups.clear();
    if (version >= 3 && Array.isArray(anyData.groups)) {
      this.context.groups.restore(anyData.groups as Group[]);
    }
    // 分组恢复后把 groupId 写回实例（restore 内部会做，这里只是保证一致）
    this.context.groups.prune();

    // 5) 设置、相机、时间
    if (version >= 2 && anyData.settings) {
      this.context.applySettings(anyData.settings as SavedSettings);
    }
    if (anyData.camera) this.context.applyCamera(anyData.camera as SavedCamera);

    grid.recount();
    grid.markAllDirty();
    this.context.onWorldReplaced(source);

    this.lastSaveAt = performance.now();
    this.observedRevision = -1;
    this.lastAutoSaveMessage = `已加载 ${source}`;
    void restoredChunks;

    return {
      ok: true,
      message: `${this.lastAutoSaveMessage}：${restoredChunks} 区块 / ${restoredBuildings} 建筑${restoredWater > 0 ? ` / ${restoredWater} 处水体` : ''}，耗时 ${(performance.now() - started).toFixed(0)} ms`,
      ms: performance.now() - started,
    };
  }
}

function isEmptyChunk(chunk: Chunk): boolean {
  const data = chunk.voxels;
  for (let i = 0; i < data.length; i++) if (data[i] !== AIR) return false;
  return true;
}
