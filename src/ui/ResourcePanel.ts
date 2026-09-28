/**
 * 资源与内存面板（补充 4.1 / 4.3）。
 *
 * 这个面板存在的唯一理由：**让「内存有没有被释放」变成可观测的**。
 * 在此之前，玩家（和我自己）只能靠「好像变卡了」来判断换地图有没有泄漏，
 * 那是猜。有了这面板，切五次地图看两行数字就够了。
 *
 * 面板分三段，对应三个不同的问题：
 *
 * 1. **当前占用**：JS 堆 / GPU 对象数 / 体素数据 / 物理体。浏览器不给堆数据时
 *    显示「不可用」而不是 0 —— 这里的每个数字都必须是真的。
 * 2. **换图记录**：每次换地图前后各采一次，给出「释放了多少项、几何/贴图增减、堆增减」。
 *    这是判断泄漏最直接的证据：正常情况几何数应当**回到同一水平**，不该一路涨。
 * 3. **上次地图生成报告**：问题 3.5 要求的「清掉多少树、让位多少、新建多少建筑」。
 */

import type { MapGenerationReport } from '../world/MapPlanner';
import { describeSnapshot, type ResourceSnapshot, type SwitchMemoryRecord } from '../world/ResourceMonitor';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface ResourcePanelHandlers {
  /** 手动回收内存（补充 4.2） */
  onCollectGarbage(): void;
  /** 把完整资源清单打到控制台（排查用） */
  onLogResources(): void;
}

export interface ResourcePanelStats {
  snapshot: ResourceSnapshot | null;
  canForceGC: boolean;
  hasHeapData: boolean;
  /** 上一次回收的结果说明（原样显示，不做美化） */
  gcNote: string;
  switchLog: readonly SwitchMemoryRecord[];
  mapReport: MapGenerationReport | null;
}

export class ResourcePanel {
  private readonly heap: HTMLElement;
  private readonly heapLimit: HTMLElement;
  private readonly gpu: HTMLElement;
  private readonly gpuMb: HTMLElement;
  private readonly voxelMb: HTMLElement;
  private readonly physics: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly gcNote: HTMLElement;
  private readonly switchLog: HTMLElement;
  private readonly mapReport: HTMLElement;
  private readonly gcButton: HTMLButtonElement;

  constructor(private readonly handlers: ResourcePanelHandlers) {
    this.heap = must<HTMLElement>('#rm-heap');
    this.heapLimit = must<HTMLElement>('#rm-heap-limit');
    this.gpu = must<HTMLElement>('#rm-gpu');
    this.gpuMb = must<HTMLElement>('#rm-gpu-mb');
    this.voxelMb = must<HTMLElement>('#rm-voxel-mb');
    this.physics = must<HTMLElement>('#rm-physics');
    this.summary = must<HTMLElement>('#rm-summary');
    this.gcNote = must<HTMLElement>('#rm-gc-note');
    this.switchLog = must<HTMLElement>('#rm-switch-log');
    this.mapReport = must<HTMLElement>('#rm-map-report');
    this.gcButton = must<HTMLButtonElement>('#btn-collect-garbage');

    this.gcButton.addEventListener('click', () => this.handlers.onCollectGarbage());
    must<HTMLElement>('#btn-log-resources').addEventListener('click', () => this.handlers.onLogResources());
  }

  /** 更新回收按钮的可用状态与提示文字 */
  setGcAvailability(canForceGC: boolean): void {
    this.gcButton.title = canForceGC
      ? '调用 window.gc() 并清空历史采样'
      : '当前浏览器没有开放 window.gc，只能清空历史采样（提示会说明）';
    this.gcButton.textContent = canForceGC ? '回收内存（可强制 GC）' : '回收内存（尽力而为）';
  }

  render(stats: ResourcePanelStats): void {
    const s = stats.snapshot;
    if (!s) {
      this.heap.textContent = stats.hasHeapData ? '等待采样' : '不可用';
      this.heapLimit.textContent = '—';
      this.gpu.textContent = '0 / 0';
      this.gpuMb.textContent = '0 MB';
      this.voxelMb.textContent = '0 MB';
      this.physics.textContent = '0 / 0';
      this.summary.textContent = '暂无采样（世界稳定后每 0.5 秒采一次）';
    } else {
      this.heap.textContent = s.heapUsedMB === null ? '不可用（非 Chromium）' : `${s.heapUsedMB.toFixed(1)} MB`;
      this.heapLimit.textContent = s.heapLimitMB === null ? '—' : `${s.heapLimitMB.toFixed(0)} MB`;
      this.gpu.textContent = `${s.geometries} / ${s.textures}（程序 ${s.programs}）`;
      this.gpuMb.textContent = `${s.estGpuMB.toFixed(0)} MB（粗估）`;
      this.voxelMb.textContent = `${s.voxelMB.toFixed(2)} MB`;
      this.physics.textContent = `${s.physicsBodies} / ${s.joints}`;
      this.summary.textContent = describeSnapshot(s);
    }

    this.gcNote.textContent = stats.gcNote;
    this.setGcAvailability(stats.canForceGC);

    this.renderSwitchLog(stats.switchLog);
    this.renderMapReport(stats.mapReport);
  }

  private renderSwitchLog(records: readonly SwitchMemoryRecord[]): void {
    if (records.length === 0) {
      this.switchLog.innerHTML = '<span class="dim">还没有换过地图。切一次地图后这里会出现前后对比。</span>';
      return;
    }
    this.switchLog.innerHTML = '';
    for (const record of [...records].reverse()) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const heap =
        record.heapDeltaMB === null
          ? '堆不可测'
          : `堆 ${record.heapDeltaMB >= 0 ? '+' : ''}${record.heapDeltaMB.toFixed(1)} MB`;
      const geometry = `${record.geometryDelta >= 0 ? '+' : ''}${record.geometryDelta} 几何`;
      const texture = `${record.textureDelta >= 0 ? '+' : ''}${record.textureDelta} 贴图`;
      const after = record.after
        ? `｜换后 几何 ${record.after.geometries} / 贴图 ${record.after.textures}`
        : '';
      row.innerHTML =
        `<b>${escapeHtml(record.label)}</b> ` +
        `<span class="${record.geometryDelta > 0 ? 'warn' : ''}">${record.ms.toFixed(0)} ms｜${geometry}｜${texture}｜${heap}</span>` +
        `<span class="dim">释放 ${record.releasedItems} 项${after}</span>`;
      this.switchLog.appendChild(row);
    }
    this.switchLog.appendChild(
      hint(
        '判断泄漏的方法：连续切同一张地图 5 次，「几何」这一列应当回到同一水平。' +
          '如果每次都 +几十 且不回落，说明有网格没被释放。',
      ),
    );
  }

  private renderMapReport(report: MapGenerationReport | null): void {
    if (!report) {
      this.mapReport.innerHTML = '<span class="dim">还没有生成过参考地图。</span>';
      return;
    }
    this.mapReport.innerHTML = '';
    const rows: [string, string][] = [
      ['自然物体种下', `${report.naturePlaced} 棵`],
      ['为非建筑让位跳过', `${report.natureSkipped} 棵`],
      ['建筑区内清除', `${report.natureCleared} 棵`],
      ['建筑放置', `${report.buildingsPlaced} 个`],
      ['修正重叠', report.overlapsFixed > 0 ? `${report.overlapsFixed} 处` : '0 处（无重叠）'],
      ['悬空建筑', `${report.floatingBuildings} 个`],
      ['生成耗时', `${report.ms.toFixed(0)} ms`],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<b>${label}</b><span>${escapeHtml(value)}</span>`;
      this.mapReport.appendChild(row);
    }
    for (const line of report.log) {
      this.mapReport.appendChild(hint(line));
    }
  }
}

function hint(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'inline-label dim';
  el.textContent = text;
  return el;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
