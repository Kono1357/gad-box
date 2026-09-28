/**
 * 设备能力探测：决定手机上开什么画质档、渲染多远。
 *
 * ## 为什么要单独一层
 *
 * 「手机上能不能玩」不是代码质量决定的，是**手机本身**决定的：
 * 一台 4 核 4GB、DPR 3 的千元机，如果按桌面默认开阴影 + 渲染距离 8，
 * 首帧就会掉到 10 FPS 以下，玩家只会觉得"这游戏卡死"。
 * 所以在 Engine 构造之前先探一次设备，给出一份**推荐质量档 + 推荐渲染距离**，
 * 玩家之后可以在设置面板里手动覆盖（`QualityState.manualOverride`）。
 *
 * ## 三条硬性要求
 *
 * 1. **任何 API 都可能不存在**：`deviceMemory` 只有 Chromium 有、
 *    `navigator.vibrate` 只有部分浏览器有、`env(safe-area-inset-*)` 在老浏览器读出来是 0。
 *    所以每个探测点都 try/catch + 类型判断，缺什么就 `null`/`0`/`false`。
 * 2. **Node 里 import 不能崩**：项目的验证脚本 `npm run verify` 在 Node 里跑，
 *    它会顺手 import 本模块（不带 DOM）。所以这里**不能有模块顶层访问**
 *    `window` / `document` / `navigator` 的代码，全部收进函数体并先判断类型。
 * 3. **可测**：把纯计算的打分逻辑拆成 `gradeDevice()`，探测部分只负责"取原始数据"，
 *    这样验证脚本可以直接喂假数据测试三档评级。
 */

/** 设备档位 */
export type MobileTier = 'low' | 'medium' | 'high';

export interface DeviceProfile {
  isTouchDevice: boolean;
  isMobile: boolean;
  /** 是否 iOS（iOS 没有 window.gc，也有别的坑） */
  isIOS: boolean;
  /** 是否 Android */
  isAndroid: boolean;
  /** navigator.deviceMemory（GB），不可用时为 null */
  deviceMemory: number | null;
  /** navigator.hardwareConcurrency 逻辑核心数，不可用时为 null */
  cpuCores: number | null;
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  /** 安全区（刘海/手势条），单位 CSS 像素 */
  safeArea: { top: number; right: number; bottom: number; left: number };
  /** 是否偏好减少动态效果 */
  prefersReducedMotion: boolean;
  /** 是否支持震动 */
  canVibrate: boolean;
  /** 综合评级 */
  tier: MobileTier;
  /** 推荐质量档（对应 QualityPresetName） */
  recommendedQuality: 'performance' | 'balanced' | 'quality';
  /** 推荐渲染距离（区块数） */
  recommendedRenderDistance: number;
  /** 一句话说明评级理由（中文，给调试面板显示） */
  reason: string;
}

/** `gradeDevice()` 的输入：只放"探测出来的原始数据"，方便测试注入假值 */
export interface GradeInput {
  isMobile: boolean;
  deviceMemory: number | null;
  cpuCores: number | null;
  devicePixelRatio: number;
  prefersReducedMotion: boolean;
}

/** 安全区四边，全部 0 是合法的（无刘海设备） */
const EMPTY_SAFE_AREA = { top: 0, right: 0, bottom: 0, left: 0 } as const;

/** 桌面端固定给最高档 */
const DESKTOP_RENDER_DISTANCE = 8;

const TIER_LABEL: Record<MobileTier, string> = {
  low: '低配',
  medium: '中配',
  high: '高配',
};

const TIER_DETAIL: Record<MobileTier, string> = {
  low: '关阴影、关 AO',
  medium: '均衡画质（开 AO）',
  high: '均衡画质（开 AO），嫌不够可以手动调到画质优先',
};

// ---------------------------------------------------------------- 纯计算部分

/**
 * 只算档位，方便测试时注入假数据。
 *
 * 规则（**阈值都是可调的**，觉得某台机器评错档就改这里，别改探测代码）：
 *
 * - `low`：`deviceMemory ≤ 2` 或 `cpuCores ≤ 4` 或（`devicePixelRatio ≥ 3` 且 `deviceMemory ≤ 4`）
 *   → 性能优先 + 渲染距离 4~5（真的差给 4，只是高分屏拖后腿给 5）。
 *   最后一条专治"1080p/1440p 屏 + 4GB 内存"的机器：几何再简单，
 *   填充率也会被 DPR 3 拖死。
 * - `high`：`deviceMemory ≥ 8` 且 `cpuCores ≥ 8` → 均衡 + 渲染距离 8。
 *   注意手机上没有"画质优先"这个选项：阴影在移动 GPU 上性价比太低，
 *   顶配也只给均衡（桌面才给 quality）。
 * - 其余 → `medium`：均衡 + 渲染距离 6。
 * - 桌面（`!isMobile`）一律 `high` + `quality` + 渲染距离 8，理由写「桌面端」。
 * - `prefersReducedMotion` 命中时**降一档**（high→medium、medium→low，low 保持），
 *   并把这件事写进 `reason` —— 开了系统级"减少动态效果"的玩家，
 *   通常也在用低端机或对帧率波动敏感，宁可少画一点。
 */
export function gradeDevice(input: GradeInput): {
  tier: MobileTier;
  recommendedQuality: DeviceProfile['recommendedQuality'];
  recommendedRenderDistance: number;
  reason: string;
} {
  const { isMobile, deviceMemory, cpuCores, devicePixelRatio, prefersReducedMotion } = input;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;

  // 给 reason 用的"配置摘要"：探测不到的项要明说"未知"，不要假装是 0
  const spec = [
    cpuCores !== null ? `${cpuCores} 核` : '核心数未知',
    deviceMemory !== null ? `${deviceMemory}GB 内存` : '内存未知',
    `DPR ${Math.round(dpr * 100) / 100}`,
  ].join(' / ');

  const reducedSuffix = prefersReducedMotion ? '；系统偏好"减少动态效果"，已降一档' : '';

  // ---- 桌面：插电 + 主动散热，直接给最高档 ----
  if (!isMobile) {
    if (prefersReducedMotion) {
      return {
        tier: 'high',
        recommendedQuality: 'balanced',
        recommendedRenderDistance: DESKTOP_RENDER_DISTANCE,
        reason: `${spec} → 桌面端：插电 + 主动散热，本该给画质优先${reducedSuffix}`,
      };
    }
    return {
      tier: 'high',
      recommendedQuality: 'quality',
      recommendedRenderDistance: DESKTOP_RENDER_DISTANCE,
      reason: `${spec} → 桌面端：插电 + 主动散热，直接给画质优先；渲染距离 ${DESKTOP_RENDER_DISTANCE}`,
    };
  }

  // ---- 移动端：先判低配，再判高配，其余中配 ----
  const lowMemory = deviceMemory !== null && deviceMemory <= 2;
  const lowCores = cpuCores !== null && cpuCores <= 4;
  const highDprLowMemory = dpr >= 3 && deviceMemory !== null && deviceMemory <= 4;

  let tier: MobileTier;
  let recommendedRenderDistance: number;

  if (lowMemory || lowCores || highDprLowMemory) {
    tier = 'low';
    // 真的差（内存/核心不够）给 4；只是高分屏拖后腿给 5
    recommendedRenderDistance = lowMemory || lowCores ? 4 : 5;
  } else if (
    deviceMemory !== null &&
    deviceMemory >= 8 &&
    cpuCores !== null &&
    cpuCores >= 8
  ) {
    tier = 'high';
    recommendedRenderDistance = DESKTOP_RENDER_DISTANCE;
  } else {
    tier = 'medium';
    recommendedRenderDistance = 6;
  }

  // 减少动态效果 → 降一档（low 已经到底，保持 low 但渲染距离照样收一点）
  if (prefersReducedMotion) {
    if (tier === 'high') tier = 'medium';
    else if (tier === 'medium') tier = 'low';
    recommendedRenderDistance = Math.max(3, recommendedRenderDistance - 2);
  }

  const recommendedQuality: DeviceProfile['recommendedQuality'] =
    tier === 'low' ? 'performance' : 'balanced';

  return {
    tier,
    recommendedQuality,
    recommendedRenderDistance,
    reason: `${spec} → ${TIER_LABEL[tier]}：${TIER_DETAIL[tier]}；渲染距离 ${recommendedRenderDistance}${reducedSuffix}`,
  };
}

// ---------------------------------------------------------------- 探测部分

/** 触摸能力：`'ontouchstart' in window` 覆盖老设备，`maxTouchPoints` 覆盖新设备 */
function detectTouchDevice(): boolean {
  try {
    if (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0) return true;
    if (typeof window !== 'undefined' && 'ontouchstart' in window) return true;
  } catch {
    /* 某些内嵌 WebView 会直接抛，忽略 */
  }
  return false;
}

/** 读取安全区：挂一个临时元素让浏览器把 `env(safe-area-inset-*)` 算成 padding，再读回来 */
function detectSafeArea(): { top: number; right: number; bottom: number; left: number } {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') return { ...EMPTY_SAFE_AREA };
    if (typeof window.getComputedStyle !== 'function') return { ...EMPTY_SAFE_AREA };

    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px);' +
      'padding-right:env(safe-area-inset-right,0px);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);' +
      'padding-left:env(safe-area-inset-left,0px);';
    const read = (v: string): number => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    try {
      document.documentElement.appendChild(probe);
      const style = window.getComputedStyle(probe);
      return {
        top: read(style.paddingTop),
        right: read(style.paddingRight),
        bottom: read(style.paddingBottom),
        left: read(style.paddingLeft),
      };
    } finally {
      // 无论如何都要摘掉临时元素，别给 DOM 留垃圾
      probe.remove();
    }
  } catch {
    return { ...EMPTY_SAFE_AREA };
  }
}

/**
 * 是否移动端：UA + 触摸能力 + 屏幕尺寸三票综合。
 *
 * 只看 UA 会被"触摸屏笔记本"骗（Windows 触屏本 UA 里也有 Touch），
 * 只看触摸又会被"iPadOS 伪装成 macOS"骗，所以三条一起看。
 */
function detectMobile(
  ua: string,
  isTouchDevice: boolean,
  screenWidth: number,
  maxTouchPoints: number,
): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS/i.test(ua)) return true;
  // iPadOS 13+ 默认请求桌面站：UA 里是 Macintosh，但触摸点数 > 1
  if (ua !== '' && /Macintosh/i.test(ua) && maxTouchPoints > 1) return true;
  if (ua !== '') return false;
  // UA 拿不到（或像 Node 那样是噪音）时的兜底：窄屏 + 触摸 + 没有精确指针设备
  if (!isTouchDevice || screenWidth <= 0 || screenWidth > 820) return false;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      // 有精确指针（鼠标 / 触控板）就当桌面 —— 触摸屏笔记本走这条路
      return !window.matchMedia('(pointer: fine)').matches;
    }
  } catch {
    /* 忽略 */
  }
  return true;
}

/** 探测设备并给出质量推荐。全部探测点都会兜底，任何环境调用都不会抛异常。 */
export function detectDevice(): DeviceProfile {
  const isTouchDevice = detectTouchDevice();

  let ua = '';
  let maxTouchPoints = 0;
  let deviceMemory: number | null = null;
  let cpuCores: number | null = null;
  let canVibrate = false;

  try {
    if (typeof navigator !== 'undefined') {
      ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
      maxTouchPoints = navigator.maxTouchPoints ?? 0;
      // deviceMemory 是 Chromium 专有（而且被粗粒度分档：0.25/0.5/1/2/4/8）
      const rawMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      deviceMemory = typeof rawMemory === 'number' && rawMemory > 0 ? rawMemory : null;
      const rawCores = navigator.hardwareConcurrency;
      cpuCores = typeof rawCores === 'number' && rawCores > 0 ? rawCores : null;
      canVibrate = typeof navigator.vibrate === 'function';
    }
  } catch {
    /* 忽略：保持上面的默认值 */
  }

  let devicePixelRatio = 1;
  let screenWidth = 0;
  let screenHeight = 0;
  let prefersReducedMotion = false;
  try {
    if (typeof window !== 'undefined') {
      devicePixelRatio = window.devicePixelRatio || 1;
      // 用视口尺寸（innerWidth/Height）而不是 screen.width —— 布局与 NDC 都按可视区算，
      // 而且 iOS 旋转后 screen.width 常常不更新
      screenWidth = window.innerWidth || window.screen?.width || 0;
      screenHeight = window.innerHeight || window.screen?.height || 0;
      if (typeof window.matchMedia === 'function') {
        prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
    }
  } catch {
    /* 忽略 */
  }

  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 伪装桌面 UA，只能靠"Macintosh + 多指触摸 + 触摸设备"认出来
    (/Macintosh/i.test(ua) && isTouchDevice && maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = detectMobile(ua, isTouchDevice, screenWidth, maxTouchPoints);

  const grade = gradeDevice({
    isMobile,
    deviceMemory,
    cpuCores,
    devicePixelRatio,
    prefersReducedMotion,
  });

  return {
    isTouchDevice,
    isMobile,
    isIOS,
    isAndroid,
    deviceMemory,
    cpuCores,
    devicePixelRatio,
    screenWidth,
    screenHeight,
    safeArea: detectSafeArea(),
    prefersReducedMotion,
    canVibrate,
    tier: grade.tier,
    recommendedQuality: grade.recommendedQuality,
    recommendedRenderDistance: grade.recommendedRenderDistance,
    reason: grade.reason,
  };
}
