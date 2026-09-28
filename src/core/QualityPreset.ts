import type { QualityPresetName } from '../appState';

/**
 * 一键画质预设（补充 5）。
 *
 * 三个档位的取舍：
 * - **性能优先**（新手默认）：关阴影、关 AO、像素比降到 1（等效关超采样）、
 *   渲染距离收到世界档位的 0.75 倍、支撑面小网格粗一点（4×4 → 3×3，少算几个候选点）。
 *   目标是新手地图 90 FPS 以上。
 * - **均衡**：世界档位的默认设置，什么都不额外关。
 * - **画质优先**：开阴影、开 AO、渲染距离放到 1.4 倍、像素比放开到设备上限。
 *
 * 关于"抗锯齿"：它是 WebGL **上下文创建时**的参数，运行时无法真正切换 ——
 * 换掉渲染器会导致所有 GPU 资源重传、画面闪一下，得不偿失。
 * 所以这里的 `antialias` 语义是"是否允许超采样"，实现上用 `devicePixelRatio` 表达：
 * 关闭时把像素比压到 1（等效关掉超采样），开启时放到设备上限。
 * 这一点在 README 里也写明了，不假装能在运行时重建上下文。
 */
export interface QualityPreset {
  name: QualityPresetName;
  label: string;
  description: string;
  /** 渲染距离相对世界档位的倍率 */
  renderDistanceScale: number;
  shadows: boolean;
  ao: boolean;
  antialias: boolean;
  /** 设备像素比上限 */
  maxPixelRatio: number;
  /** 支撑面小网格密度（越大候选点越多、摆放越精细） */
  surfaceGrid: number;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  performance: {
    name: 'performance',
    label: '性能优先',
    description: '关阴影、关 AO、缩短渲染距离。新手地图的目标是 90 FPS 以上。',
    renderDistanceScale: 0.75,
    shadows: false,
    ao: false,
    antialias: false,
    maxPixelRatio: 1,
    surfaceGrid: 3,
  },
  balanced: {
    name: 'balanced',
    label: '均衡',
    description: '按世界档位的默认设置跑，保留 AO 让地形有层次。',
    renderDistanceScale: 1,
    shadows: false,
    ao: true,
    antialias: true,
    maxPixelRatio: 1.5,
    surfaceGrid: 4,
  },
  quality: {
    name: 'quality',
    label: '画质优先',
    description: '开阴影、开 AO、加长渲染距离、放开像素比。适合台式机。',
    renderDistanceScale: 1.4,
    shadows: true,
    ao: true,
    antialias: true,
    maxPixelRatio: 2,
    surfaceGrid: 5,
  },
};

export function getQualityPreset(name: QualityPresetName): QualityPreset {
  return QUALITY_PRESETS[name] ?? QUALITY_PRESETS.balanced;
}

/** 按世界档位的基准渲染距离与预设倍率，算出实际渲染距离 */
export function resolveRenderDistance(base: number, presetName: QualityPresetName): number {
  const preset = getQualityPreset(presetName);
  return Math.max(3, Math.round(base * preset.renderDistanceScale));
}
