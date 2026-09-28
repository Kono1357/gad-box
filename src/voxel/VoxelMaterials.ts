import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace } from 'three';
import type { TexturePattern, VoxelTextureSpec } from '../data/voxelTypes';
import { VOXEL_TYPES } from '../data/voxelTypes';
import { RENDER_CONFIG } from '../config';
import { mulberry32 } from '../core/random';

/** 面种类在纹理图集里的排列顺序（每个体素固定占 3 块贴图） */
export const FACE_TOP = 0;
export const FACE_SIDE = 1;
export const FACE_BOTTOM = 2;
export const FACES_PER_TYPE = 3;

/** 单块贴图的绘制接口 */
interface TilePainter {
  readonly size: number;
  readonly data: Uint8Array;
  rnd(): number;
  set(x: number, y: number, color: number, mix?: number): void;
  fill(color: number): void;
  fillRect(x0: number, y0: number, x1: number, y1: number, color: number): void;
  line(x0: number, y0: number, x1: number, y1: number, color: number, mix?: number): void;
}

function createPainter(size: number, seed: number): TilePainter {
  const data = new Uint8Array(size * size * 3);
  const rnd = mulberry32(seed);

  const set = (x: number, y: number, color: number, mix = 1): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    if (mix >= 1) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      return;
    }
    data[i] = data[i]! + (r - data[i]!) * mix;
    data[i + 1] = data[i + 1]! + (g - data[i + 1]!) * mix;
    data[i + 2] = data[i + 2]! + (b - data[i + 2]!) * mix;
  };

  return {
    size,
    data,
    rnd,
    set,
    fill(color: number): void {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, color);
    },
    fillRect(x0: number, y0: number, x1: number, y1: number, color: number): void {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, color);
    },
    line(x0: number, y0: number, x1: number, y1: number, color: number, mix = 1): void {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= steps; i++) {
        set(
          Math.round(x0 + ((x1 - x0) * i) / steps),
          Math.round(y0 + ((y1 - y0) * i) / steps),
          color,
          mix,
        );
      }
    },
  };
}

/** 把 0~255 的通道值做亮度缩放 */
function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

/**
 * 图案表。每个函数把一块 tileSize×tileSize 的贴图画出来。
 *
 * 设计原则：只用"底色 + 次要色 + 明暗"三件事表达材质，
 * 因为低多边形平涂风格里，纹理的作用是**区分**而不是写实。
 * 顶部左下角会统一压一圈暗边（见 EDGE_DARKEN），让相邻方块之间出现清晰的分界线。
 */
const PATTERNS: Record<TexturePattern, (p: TilePainter, base: number, accent: number, density: number) => void> = {
  solid(p, base) {
    p.fill(base);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        if (p.rnd() < 0.08) p.set(x, y, base, 0.5);
      }
    }
  },

  noise(p, base, accent, density) {
    p.fill(base);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const r = p.rnd();
        if (r < 0.35 * density + 0.15) p.set(x, y, accent, 0.18 + r * 0.3);
      }
    }
  },

  speckle(p, base, accent, density) {
    p.fill(base);
    const blobs = Math.round(6 + density * 14);
    for (let i = 0; i < blobs; i++) {
      const cx = Math.floor(p.rnd() * p.size);
      const cy = Math.floor(p.rnd() * p.size);
      const r = 1 + Math.floor(p.rnd() * 2);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) p.set(cx + dx, cy + dy, accent, 0.55 + p.rnd() * 0.3);
        }
      }
    }
  },

  dots(p, base, accent, density) {
    p.fill(base);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const r = p.rnd();
        if (r < 0.22 * density) p.set(x, y, accent, 0.5);
        else if (r > 0.96) p.set(x, y, shade(base, 1.12), 0.7);
      }
    }
  },

  brick(p, base, accent, density) {
    p.fill(accent);
    const rowHeight = Math.max(6, Math.round(p.size / 4));
    const brickWidth = Math.max(8, Math.round(p.size / 2));
    const gap = 1;
    for (let row = 0, y = 0; y < p.size; row++, y += rowHeight) {
      const offset = row % 2 === 0 ? 0 : Math.round(brickWidth / 2);
      for (let x = -brickWidth; x < p.size + brickWidth; x += brickWidth) {
        const x0 = x + offset + gap;
        const y0 = y + gap;
        const x1 = x + offset + brickWidth - gap - 1;
        const y1 = y + rowHeight - gap - 1;
        const tone = 1 + (p.rnd() - 0.5) * 0.18 * density;
        p.fillRect(x0, y0, x1, y1, shade(base, tone));
      }
    }
  },

  plank(p, base, accent, density) {
    p.fill(base);
    const boardHeight = Math.max(6, Math.round(p.size / 4));
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const tone = 1 + Math.sin((x + y * 3) * 0.7) * 0.04 * density;
        p.set(x, y, shade(base, tone), 0.6);
      }
    }
    for (let y = boardHeight - 1; y < p.size; y += boardHeight) {
      for (let x = 0; x < p.size; x++) p.set(x, y, accent, 0.85);
    }
  },

  vertical(p, base, accent, density) {
    p.fill(base);
    const stripeWidth = Math.max(5, Math.round(p.size / 4));
    for (let x = 0; x < p.size; x += stripeWidth) {
      for (let y = 0; y < p.size; y++) {
        const r = p.rnd();
        if (r < 0.3 * density) p.set(x + 1, y, accent, 0.45);
        if (r > 0.9) p.set(x + stripeWidth - 1, y, accent, 0.35);
      }
    }
    // 木节
    const knots = Math.round(density * 3);
    for (let i = 0; i < knots; i++) {
      const cx = Math.floor(p.rnd() * p.size);
      const cy = Math.floor(p.rnd() * p.size);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= 2) p.set(cx + dx, cy + dy, accent, 0.6);
        }
      }
    }
  },

  grass_top(p, base, accent, density) {
    p.fill(base);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const r = p.rnd();
        if (r < 0.4 * density) p.set(x, y, accent, 0.35);
        else if (r > 0.93) p.set(x, y, shade(base, 1.15), 0.6);
      }
    }
  },

  /** 草方块侧面：上部草沿 + 下部泥土，交界处做成锯齿状 */
  grass_side(p, base, accent, density) {
    const soil = 0x7a5c3c;
    p.fill(soil);
    const band = Math.max(5, Math.round(p.size * 0.3));
    for (let x = 0; x < p.size; x++) {
      const jag = Math.round(p.rnd() * 4 * density);
      for (let y = 0; y < band - jag; y++) p.set(x, y, base, 1);
      for (let y = Math.max(0, band - jag); y < band; y++) p.set(x, y, accent, 0.7);
    }
    for (let y = band; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        if (p.rnd() < 0.3 * density) p.set(x, y, shade(soil, 0.85), 0.5);
      }
    }
  },

  grid(p, base, accent, density) {
    p.fill(base);
    const cell = Math.max(8, Math.round(p.size / 2));
    for (let i = 0; i <= p.size; i += cell) {
      for (let x = 0; x < p.size; x++) {
        p.set(x, Math.min(p.size - 1, i), accent, 0.8);
        p.set(Math.min(p.size - 1, i), x, accent, 0.8);
      }
    }
    // 斜向高光
    for (let i = 0; i < p.size; i++) {
      p.set(i, Math.max(0, i - 3), 0xffffff, 0.18 + density * 0.2);
    }
  },

  wave(p, base, accent, density) {
    p.fill(base);
    for (let y = 0; y < p.size; y++) {
      const phase = Math.sin((y / p.size) * Math.PI * 3) * 0.5 + 0.5;
      for (let x = 0; x < p.size; x++) {
        const ripple = Math.sin((x / p.size) * Math.PI * 4 + y * 0.4) * 0.5 + 0.5;
        const t = phase * ripple * density;
        if (t > 0.35) p.set(x, y, accent, t * 0.5);
      }
    }
  },

  crystal(p, base, accent, density) {
    p.fill(base);
    const lines = Math.round(3 + density * 5);
    for (let i = 0; i < lines; i++) {
      const x0 = Math.floor(p.rnd() * p.size);
      const y0 = 0;
      const x1 = x0 + Math.round((p.rnd() - 0.5) * p.size * 0.6);
      p.line(x0, y0, x1, p.size, accent, 0.45);
    }
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        if (p.rnd() < 0.12) p.set(x, y, 0xffffff, 0.35);
      }
    }
  },

  metal(p, base, accent, density) {
    p.fill(base);
    for (let y = 0; y < p.size; y++) {
      const r = p.rnd();
      for (let x = 0; x < p.size; x++) {
        if (r < 0.25 * density) p.set(x, y, accent, 0.22);
        else if (r > 0.8) p.set(x, y, shade(base, 0.88), 0.5);
      }
    }
    // 高光条
    for (let i = 0; i < Math.round(p.size * 0.25); i++) {
      p.set(Math.floor(p.size * 0.3) + i, Math.floor(p.size * 0.25), 0xffffff, 0.5);
    }
  },

  leaves(p, base, accent, density) {
    p.fill(base);
    const blobs = Math.round(10 + density * 16);
    for (let i = 0; i < blobs; i++) {
      const cx = Math.floor(p.rnd() * p.size);
      const cy = Math.floor(p.rnd() * p.size);
      const r = 2 + Math.floor(p.rnd() * 3);
      const tone = p.rnd() < 0.5 ? accent : shade(base, 1.18);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r && p.rnd() < 0.7) p.set(cx + dx, cy + dy, tone, 0.75);
        }
      }
    }
  },

  cactus(p, base, accent, _density) {
    p.fill(base);
    const ridges = 4;
    for (let i = 0; i < ridges; i++) {
      const x = Math.round(((i + 0.5) * p.size) / ridges);
      for (let y = 0; y < p.size; y++) p.set(x, y, shade(base, 0.7), 0.7);
      for (let y = 1; y < p.size; y += 4) p.set(x + 1, y, accent, 0.9);
    }
  },

  lava(p, base, accent, density) {
    p.fill(0x2a1a12);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const v = Math.sin(x * 0.5) * Math.cos(y * 0.7);
        if (v > 0.35 - density * 0.4) p.set(x, y, base, 0.9);
        else if (v > -0.1) p.set(x, y, accent, 0.6);
        else if (p.rnd() < 0.1) p.set(x, y, 0xffffff, 0.35);
      }
    }
  },

  marble(p, base, accent, density) {
    p.fill(base);
    const veins = Math.round(2 + density * 4);
    for (let i = 0; i < veins; i++) {
      let x = p.rnd() * p.size;
      let y = 0;
      while (y < p.size) {
        p.set(Math.round(x), Math.round(y), accent, 0.35);
        x += (p.rnd() - 0.5) * 3;
        y += 1;
      }
    }
  },
};

/** 图集的单块贴图在 UV 空间的矩形 */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * 程序化纹理图集。
 *
 * 为什么是图集而不是"每种体素一张贴图"：
 * 一个区块的所有面共用一份材质、一次 draw call，前提是所有贴图在一张纹理上。
 * 如果用多张贴图，要么每种材质一次 draw call（区块数 × 材质数，性能爆炸），
 * 要么用纹理数组并改 shader。
 *
 * 为什么用 DataTexture 而不是 Canvas：
 * 1. 可以直接把像素写进 `Uint8Array`，不依赖 DOM 的 canvas 2D 实现；
 * 2. **可以在 Node 里单测**（`npm run verify` 会检查每种体素的贴图确实有图案、
 *    顶面与侧面确实不同），Canvas 版本做不到这一点；
 * 3. 没有 canvas 尺寸上限与跨浏览器像素差异。
 */
export class VoxelAtlas {
  readonly texture: DataTexture;
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  /** 每块贴图的 UV 尺寸（已经内缩半像素，避免图集相邻块渗色） */
  private readonly uSpan: number;
  private readonly vSpan: number;

  constructor(tileSize: number = RENDER_CONFIG.atlasTileSize, columns: number = RENDER_CONFIG.atlasColumns) {
    this.tileSize = tileSize;
    this.columns = columns;

    const typeCount = VOXEL_TYPES.length;
    const tileCount = typeCount * FACES_PER_TYPE;
    this.rows = Math.max(1, Math.ceil(tileCount / columns));
    this.width = columns * tileSize;
    this.height = this.rows * tileSize;

    const buffer = new Uint8Array(this.width * this.height * 4);
    buffer.fill(255); // 默认不透明

    for (const def of VOXEL_TYPES) {
      if (def.id === 0) continue; // air 不画
      for (let face = 0; face < FACES_PER_TYPE; face++) {
        this.paintTile(buffer, def.id, face, def.texture);
      }
    }

    this.texture = new DataTexture(buffer, this.width, this.height, RGBAFormat);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 1;
    this.texture.needsUpdate = true;

    this.uSpan = tileSize / this.width;
    this.vSpan = tileSize / this.height;
  }

  /** 图集里第 index 块贴图占据的 UV 矩形（已内缩半个像素） */
  uvRectByIndex(index: number): UvRect {
    const col = index % this.columns;
    const row = Math.floor(index / this.columns);
    const insetU = 0.5 / this.width;
    const insetV = 0.5 / this.height;
    // 纹理第 0 行在 v = 0（DataTexture 不做 flipY），所以设计上的第 row 行要从上往下映射
    const v0 = (this.rows - 1 - row) * this.vSpan;
    const u0 = col * this.uSpan;
    return { u0: u0 + insetU, v0: v0 + insetV, u1: u0 + this.uSpan - insetU, v1: v0 + this.vSpan - insetV };
  }

  /** 某体素某面的 UV 矩形 */
  uvRect(typeId: number, faceKind: number): UvRect {
    return this.uvRectByIndex(typeId * FACES_PER_TYPE + faceKind);
  }

  /** 释放显存 */
  dispose(): void {
    this.texture.dispose();
  }

  // ------------------------------------------------------------------ 内部

  private tileIndex(typeId: number, faceKind: number): number {
    return typeId * FACES_PER_TYPE + faceKind;
  }

  private paintTile(
    buffer: Uint8Array,
    typeId: number,
    faceKind: number,
    spec: VoxelTextureSpec,
  ): void {
    const def = VOXEL_TYPES[typeId]!;
    const size = this.tileSize;

    // 选择这一面用哪套图案与颜色
    let pattern: TexturePattern = spec.pattern;
    let base = spec.sideColor ?? def.color;
    if (faceKind === FACE_TOP) {
      pattern = spec.topPattern ?? spec.pattern;
      base = spec.topColor ?? spec.sideColor ?? def.color;
    } else if (faceKind === FACE_BOTTOM) {
      pattern = spec.bottomPattern ?? spec.pattern;
      base = spec.bottomColor ?? spec.sideColor ?? def.color;
    }

    const accent = spec.accent ?? shade(base, 0.82);
    const density = spec.density ?? 0.5;

    const painter = createPainter(size, def.id * 977 + faceKind * 131 + 17);
    PATTERNS[pattern]( painter, base, accent, density);

    // 统一的边缘压暗：让相邻方块之间出现清晰分界（低多边形风格里比反锯齿管用）
    const edge = shade(base, 0.72);
    for (let i = 0; i < size; i++) {
      painter.set(i, 0, edge, 0.55);
      painter.set(i, size - 1, edge, 0.75);
      painter.set(0, i, edge, 0.5);
      painter.set(size - 1, i, edge, 0.6);
    }
    // 对角高光：左上角稍微提亮，读起来像被光打到的边框
    for (let i = 0; i < size; i++) {
      painter.set(i, 0, shade(base, 1.25), 0.25);
      painter.set(0, i, shade(base, 1.15), 0.2);
    }

    this.blit(buffer, this.tileIndex(typeId, faceKind), painter);
  }

  /** 把 tile 像素（0,0 在左上）翻转着拷进图集缓冲（v = 0 在缓冲第 0 行） */
  private blit(buffer: Uint8Array, index: number, painter: TilePainter): void {
    const tile = this.tileSize;
    const col = index % this.columns;
    const row = Math.floor(index / this.columns);
    const baseX = col * tile;
    const baseY = (this.rows - 1 - row) * tile;

    for (let y = 0; y < tile; y++) {
      const flippedY = tile - 1 - y;
      for (let x = 0; x < tile; x++) {
        const src = (y * tile + x) * 3;
        const dst = ((baseY + flippedY) * this.width + (baseX + x)) * 4;
        buffer[dst] = painter.data[src]!;
        buffer[dst + 1] = painter.data[src + 1]!;
        buffer[dst + 2] = painter.data[src + 2]!;
        buffer[dst + 3] = 255;
      }
    }
  }
}

/** 取某体素顶 / 侧 / 底的代表色（UI 图例与缩略图用） */
export function voxelFaceColors(typeId: number): { top: number; side: number; bottom: number } {
  const def = VOXEL_TYPES[typeId];
  if (!def) return { top: 0x000000, side: 0x000000, bottom: 0x000000 };
  const spec = def.texture;
  return {
    top: spec.topColor ?? spec.sideColor ?? def.color,
    side: spec.sideColor ?? def.color,
    bottom: spec.bottomColor ?? spec.sideColor ?? def.color,
  };
}
