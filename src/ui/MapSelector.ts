import { BUILTIN_MAPS, DEFAULT_MAP_ID } from '../data/maps';
import type { MapDefinition } from '../data/maps';
import { WORLD_SIZE_LIST, getWorldSize } from '../worldSize';
import type { WorldSizeId } from '../worldSize';
import { colorToHexString } from '../data/voxelTypes';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface MapSelectorHandlers {
  /** 载入某张参考地图 */
  onLoadMap(map: MapDefinition): void;
  /** 新建一张空白世界（只按尺寸与种子生成地形） */
  onCreateEmpty(sizeId: WorldSizeId): void;
  onImport(file: File): void;
  /** 关闭菜单（继续当前世界） */
  onClose(): void;
}

/**
 * 主菜单 / 参考地图选择器。
 *
 * 第一次打开会自动弹出（第一印象很重要：新玩家不该对着一片荒地发呆）。
 * 这里同时承担三件事：
 * 1. **载入参考地图** —— 4 张内置地图，带缩略图色条、难度、展示点与推荐玩法；
 * 2. **新建空白世界** —— 三档世界尺寸，配一句性能预期；
 * 3. **导入存档** —— 把外面拿到的 JSON 直接拖进来。
 *
 * 载入前**不弹二次确认**，但会提示"当前世界的改动会被覆盖" ——
 * 因为地图载入是可逆的（重新生成即可），而弹窗会打断"随便点开看看"的探索欲。
 * 真正不可逆的操作（清空存档）才做确认。
 */
export class MapSelector {
  private readonly overlay: HTMLElement;
  private readonly mapList: HTMLElement;
  private readonly sizeList: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly hint: HTMLElement;

  private selectedMapId: string = DEFAULT_MAP_ID;
  private selectedSize: WorldSizeId = 'novice';

  constructor(private readonly handlers: MapSelectorHandlers) {
    this.overlay = must<HTMLElement>('#main-menu');
    this.mapList = must<HTMLElement>('#map-list');
    this.sizeList = must<HTMLElement>('#world-size-list');
    this.fileInput = must<HTMLInputElement>('#file-input');
    this.hint = must<HTMLElement>('#menu-hint');

    this.renderSizes();
    this.renderMaps();
    this.bind();
  }

  private bind(): void {
    must<HTMLElement>('#menu-load-map').addEventListener('click', () => {
      const map = BUILTIN_MAPS.find((item) => item.id === this.selectedMapId) ?? BUILTIN_MAPS[0]!;
      this.close();
      this.handlers.onLoadMap(map);
    });

    must<HTMLElement>('#menu-empty-world').addEventListener('click', () => {
      this.close();
      this.handlers.onCreateEmpty(this.selectedSize);
    });

    must<HTMLElement>('#menu-import').addEventListener('click', () => {
      this.fileInput.value = '';
      this.fileInput.click();
    });

    must<HTMLElement>('#menu-close').addEventListener('click', () => {
      this.close();
      this.handlers.onClose();
    });

    // 点遮罩关闭（点卡片内部不关）
    this.overlay.addEventListener('click', (ev) => {
      if (ev.target === this.overlay) {
        this.close();
        this.handlers.onClose();
      }
    });
  }

  private renderSizes(): void {
    this.sizeList.innerHTML = '';
    for (const preset of WORLD_SIZE_LIST) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'size-card';
      button.dataset.sizeId = preset.id;
      const voxels = preset.sizeX * preset.sizeY * preset.sizeZ;
      button.innerHTML =
        `<b>${preset.name}</b>` +
        `<small>${(voxels / 1000).toFixed(0)} 千体素 · ${
          (preset.sizeX / preset.chunkSize) * (preset.sizeZ / preset.chunkSize)
        } 区块</small>` +
        `<small class="dim">${preset.description}</small>`;
      button.addEventListener('click', () => {
        this.selectedSize = preset.id;
        this.markSize();
        this.updateHint();
      });
      this.sizeList.appendChild(button);
    }
    this.markSize();
  }

  private markSize(): void {
    for (const button of this.sizeList.querySelectorAll<HTMLButtonElement>('.size-card')) {
      button.classList.toggle('active', button.dataset.sizeId === this.selectedSize);
    }
  }

  private renderMaps(): void {
    this.mapList.innerHTML = '';
    for (const map of BUILTIN_MAPS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'map-card';
      card.dataset.mapId = map.id;

      const palette = map.palette.map((color) => colorToHexString(color)).join(', ');
      card.innerHTML =
        `<span class="map-thumb" style="background:linear-gradient(135deg, ${palette})">${map.emoji}</span>` +
        `<span class="map-body">` +
        `<span class="map-title"><b>${map.name}</b>` +
        `<em class="diff diff-${map.difficulty}">${map.difficulty}</em>` +
        `<em class="size">${getWorldSize(map.size).name}</em></span>` +
        `<span class="map-desc">${map.description}</span>` +
        `<span class="map-tags">${map.showcase.map((tag) => `<i>${tag}</i>`).join('')}</span>` +
        `<span class="map-tip">💡 ${map.recommended}</span>` +
        `</span>`;

      card.addEventListener('click', () => {
        this.selectedMapId = map.id;
        this.markMap();
        this.updateHint();
      });
      // 双击直接载入，省一次点击
      card.addEventListener('dblclick', () => {
        this.selectedMapId = map.id;
        this.close();
        this.handlers.onLoadMap(map);
      });

      this.mapList.appendChild(card);
    }
    this.markMap();
    this.updateHint();
  }

  private markMap(): void {
    for (const card of this.mapList.querySelectorAll<HTMLButtonElement>('.map-card')) {
      card.classList.toggle('active', card.dataset.mapId === this.selectedMapId);
    }
  }

  private updateHint(): void {
    const map = BUILTIN_MAPS.find((item) => item.id === this.selectedMapId);
    if (!map) {
      this.hint.textContent = `新建空白世界：${getWorldSize(this.selectedSize).name}`;
      return;
    }
    this.hint.textContent =
      `当前选中：${map.emoji} ${map.name}（${map.difficulty}）— 载入会覆盖当前世界，` +
      `想保留请先「导出 JSON」。双击卡片可直接载入。`;
  }

  open(): void {
    this.overlay.classList.add('visible');
  }

  close(): void {
    this.overlay.classList.remove('visible');
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('visible');
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** 修改选中的尺寸（外部同步用） */
  setSize(sizeId: WorldSizeId): void {
    this.selectedSize = sizeId;
    this.markSize();
  }
}
