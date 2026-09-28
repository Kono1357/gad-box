import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  type BufferGeometry,
} from 'three';
import type { BuildingDef, BuildingInstance } from './types';

/**
 * 放置时的幽灵预览。
 *
 * 绿 = 可以放，红 = 不行（越界 / 和地形穿插 / 和已有建筑重叠）。
 * 除了实体预览，还画一个线框包围盒，让玩家看清占地范围 ——
 * 尤其在放"巴士""起重机"这种大件的时候，光看实体判断不出边界。
 */
export class BuildingPreview {
  readonly group = new Group();

  private readonly validMaterial: MeshLambertMaterial;
  private readonly invalidMaterial: MeshLambertMaterial;
  private readonly boxMaterial: LineBasicMaterial;
  private readonly box: LineSegments;
  private readonly mesh: Mesh;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private currentDefId: string | null = null;

  constructor() {
    this.group.name = 'building-preview';

    this.validMaterial = this.track(
      new MeshLambertMaterial({
        color: 0x7fd06a,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        flatShading: true,
      }),
    );
    this.invalidMaterial = this.track(
      new MeshLambertMaterial({
        color: 0xff5a5a,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        flatShading: true,
      }),
    );

    this.mesh = new Mesh(new BoxGeometry(1, 1, 1), this.validMaterial);
    this.mesh.visible = false;
    this.group.add(this.mesh);

    this.boxMaterial = this.track(
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
    );
    this.box = new LineSegments(
      this.track(new EdgesGeometry(new BoxGeometry(1, 1, 1))),
      this.boxMaterial,
    );
    this.box.visible = false;
    this.group.add(this.box);

    this.group.visible = false;
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  /** 切换当前预览的模型（几何体由外部缓存提供，这里不自己造） */
  setGeometry(defId: string, geometry: BufferGeometry | null): void {
    if (this.currentDefId === defId) return;
    this.currentDefId = defId;
    if (!geometry) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.geometry = geometry;
  }

  /**
   * 更新预览位置与合法性。
   * @param def 模型定义（用于包围盒线框）
   * @param position 底面中心世界坐标
   * @param rotationY 旋转
   * @param valid 是否可以放置
   */
  update(
    def: BuildingDef | null,
    position: [number, number, number] | null,
    rotationY: number,
    valid: boolean,
    visible: boolean,
  ): void {
    if (!def || !position || !visible) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.mesh.material = valid ? this.validMaterial : this.invalidMaterial;

    this.mesh.position.set(position[0], position[1], position[2]);
    this.mesh.rotation.set(0, rotationY, 0);
    this.mesh.visible = this.currentDefId === def.id;

    // 包围盒线框：按旋转后的水平占地画
    const cos = Math.abs(Math.cos(rotationY));
    const sin = Math.abs(Math.sin(rotationY));
    const sizeX = def.size[0] * cos + def.size[2] * sin;
    const sizeZ = def.size[0] * sin + def.size[2] * cos;

    this.box.visible = true;
    this.box.position.set(position[0], position[1] + def.size[1] / 2, position[2]);
    this.box.scale.set(sizeX + 0.1, def.size[1] + 0.1, sizeZ + 0.1);
    this.boxMaterial.color.setHex(valid ? 0x7fd06a : 0xff5a5a);
  }

  hide(): void {
    this.group.visible = false;
  }

  /** 目前是否在显示 */
  get visible(): boolean {
    return this.group.visible;
  }

  dispose(): void {
    for (const resource of this.disposables) resource.dispose();
    this.disposables.length = 0;
    this.mesh.geometry = new BoxGeometry(1, 1, 1);
  }
}

/** 供 UI 显示的预览提示文案 */
export function describePlacement(
  def: BuildingDef | null,
  instance: BuildingInstance | null,
  valid: boolean,
  reason?: string,
): string {
  if (instance) return `已选中 #${instance.id} ${instance.name ?? instance.defId}`;
  if (!def) return '未选择建筑模型';
  if (valid) return `${def.name}｜${def.size[0]}×${def.size[1]}×${def.size[2]} m｜可放置`;
  return `${def.name}｜不可放置：${reason ?? '未知原因'}`;
}
