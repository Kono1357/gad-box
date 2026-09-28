/**
 * 内容使用统计（`src/data/contentStats.ts`）的纯逻辑断言（M4 第 7 批）。
 *
 * 为什么不写进 `scripts/verify.ts`：那个文件是并发编辑的公共入口，加进去必然冲突。
 * 这里导出一个 `runContentStatsChecks(check)`，跑法见同目录的 `contentstats.run.ts`：
 *
 * ```bash
 * npx esbuild scripts/checks/contentstats.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/contentstats.mjs && node .verify/contentstats.mjs
 * ```
 *
 * 断言的重点是**不变量**而不是具体数字：分箱总数守恒、越界不丢物体、
 * 拿不到尺寸时不编造箱子。这些才是"统计面板开始骗人"的入口 ——
 * 一个显示错了的分类占比没人会注意，但"总数对不上"意味着整个世界都被算错了。
 */

import { BUILDING_CATALOG } from '../../src/data/buildingCatalog';
import type { BuildingDef } from '../../src/building/types';
import {
  CONTENT_PACKS,
  CONTENT_PACK_STORAGE_KEY,
  defaultEnabledPacks,
  describePacks,
  packCounts,
} from '../../src/data/contentPacks';
import { computeContentStats } from '../../src/data/contentStats';
import type { PlacedObjectLike } from '../../src/data/contentStats';
import { ContentPackUI } from '../../src/ui/ContentPackUI';
import { ContentStatsUI } from '../../src/ui/ContentStatsUI';

export type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/** 造一个"世界里已放置的物体"。只给统计需要的最小字段 */
function obj(defId: string, x: number, z: number, y = 0): PlacedObjectLike {
  return { defId, position: [x, y, z] };
}

/** 用固定种子的线性同余发生器造坐标：断言必须可复现，不能用 Math.random */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 分箱计数总和 —— 守恒断言唯一的检查方式 */
function binSum(bins: readonly { count: number }[]): number {
  let sum = 0;
  for (const bin of bins) sum += bin.count;
  return sum;
}

/** 目录里第一个可放置的、属于某分类的模型（拿不到就返回 undefined，断言会如实报 false） */
function pickPlaceable(category: string): BuildingDef | undefined {
  return BUILDING_CATALOG.find((def) => def.category === category && def.isPlaceable !== false);
}

export function runContentStatsChecks(check: CheckFn): void {
  // ==================================================================
  // 1. 目录数据的前置事实（断言建立在它们之上，所以先核实）
  // ==================================================================

  const placeableTotal = BUILDING_CATALOG.filter((def) => def.isPlaceable !== false).length;
  const notPlaceable = BUILDING_CATALOG.length - placeableTotal;

  check(
    'coverage 的分母口径 = 目录里 isPlaceable !== false 的模型数',
    computeContentStats([], { sizeX: 16, sizeZ: 16 }).totalCatalog === placeableTotal,
    `totalCatalog=${computeContentStats([], { sizeX: 16, sizeZ: 16 }).totalCatalog}，手数=${placeableTotal}，目录共 ${BUILDING_CATALOG.length}`,
  );
  // 如实记录：当前目录里没有 isPlaceable === false 的模型，所以"只算可放置"这条口径
  // 在当前数据上**产生不了任何差异**。这里把它断言出来，是为了将来真加了不可放置模型时，
  // 这条断言会失败并提醒"该去看 coverage 是否还符合预期"，而不是让口径悄悄变了没人知道。
  check(
    '目录里目前没有不可放置的模型（该口径当前无差异，如实记录）',
    notPlaceable === 0,
    `不可放置 ${notPlaceable} 个`,
  );

  const categoriesInCatalog = [...new Set(BUILDING_CATALOG.map((def) => def.category))];
  const catA = categoriesInCatalog[0];
  const catB = categoriesInCatalog[1];
  const catC = categoriesInCatalog[2];
  const defA = catA ? pickPlaceable(catA) : undefined;
  const defB = catB ? pickPlaceable(catB) : undefined;
  const defC = catC ? pickPlaceable(catC) : undefined;
  const haveThreeCategories = defA !== undefined && defB !== undefined && defC !== undefined;
  check(
    '目录里至少有 3 个一级分类，且每个分类都有可放置模型（后续分类断言的前提）',
    haveThreeCategories,
    `分类数 ${categoriesInCatalog.length}`,
  );

  // ==================================================================
  // 2. 空世界
  // ==================================================================

  const empty = computeContentStats([], { sizeX: 8, sizeZ: 8 });

  check('空世界：totalObjects === 0', empty.totalObjects === 0, `${empty.totalObjects}`);
  check('空世界：maxBinCount === 0', empty.maxBinCount === 0, `${empty.maxBinCount}`);
  check('空世界：coverage === 0', empty.coverage === 0, `${empty.coverage}`);
  check(
    '空世界：尺寸给了就能分箱，binsUnavailableReason 为 null',
    empty.binsUnavailableReason === null,
    empty.binsUnavailableReason ?? 'null',
  );
  check(
    '空世界：仍然给出完整的 8×8 空箱子（不是空数组）',
    empty.bins.length === 64 && empty.binCols === 8 && empty.binRows === 8,
    `bins=${empty.bins.length}，${empty.binCols}×${empty.binRows}`,
  );
  check('空世界：所有箱子都是 0 个', binSum(empty.bins) === 0 && empty.bins.every((b) => b.count === 0));
  check('空世界：分类 / 二级分类 / top 都是空数组', empty.categories.length === 0 && empty.subcategories.length === 0 && empty.top.length === 0);

  // ==================================================================
  // 3. 世界尺寸非法 → 不编造箱子
  // ==================================================================

  const oneObj = [obj(defA?.id ?? 'unknown_id', 1, 1)];

  const zeroSize = computeContentStats(oneObj, { sizeX: 0, sizeZ: 8 });
  check('尺寸 0：bins 是空数组（不编造假箱子）', zeroSize.bins.length === 0, `bins=${zeroSize.bins.length}`);
  check(
    '尺寸 0：binsUnavailableReason 给出了中文原因',
    typeof zeroSize.binsUnavailableReason === 'string' && /[\u4e00-\u9fa5]/.test(zeroSize.binsUnavailableReason),
    zeroSize.binsUnavailableReason ?? '(null)',
  );
  check(
    '尺寸 0：binCols / binRows 都是 0（0 = 这次没有分箱，与 bins 为空一致）',
    zeroSize.binCols === 0 && zeroSize.binRows === 0,
    `${zeroSize.binCols}×${zeroSize.binRows}`,
  );
  check('尺寸 0：maxBinCount 仍然是 0', zeroSize.maxBinCount === 0);

  const nanSize = computeContentStats(oneObj, { sizeX: Number.NaN, sizeZ: 8 });
  check(
    '尺寸 NaN：bins 为空且原因里如实写出是哪个值坏了（含 NaN 字样）',
    nanSize.bins.length === 0 && (nanSize.binsUnavailableReason ?? '').includes('NaN'),
    nanSize.binsUnavailableReason ?? '(null)',
  );
  const infSize = computeContentStats(oneObj, { sizeX: 8, sizeZ: Number.POSITIVE_INFINITY });
  check(
    '尺寸 Infinity：同样不分箱（Infinity 不是合法尺寸）',
    infSize.bins.length === 0 && infSize.binsUnavailableReason !== null,
    infSize.binsUnavailableReason ?? '(null)',
  );
  check(
    '尺寸非法时物体仍然计入 totalObjects（不因为画不出图就少算）',
    zeroSize.totalObjects === 1 && nanSize.totalObjects === 1,
    `${zeroSize.totalObjects} / ${nanSize.totalObjects}`,
  );

  // ==================================================================
  // 4. 分箱：守恒（最重要的不变量）、边界、越界
  // ==================================================================

  const defId = defA?.id ?? 'unknown_id';
  const many: PlacedObjectLike[] = [];
  const rand = lcg(20240607);
  for (let i = 0; i < 120; i += 1) {
    // 尺寸 16×16，坐标全在 [0, 16)
    many.push(obj(defId, rand() * 15.999, rand() * 15.999));
  }
  // 越界的三类：负坐标、超出尺寸、NaN 坐标。它们必须**被夹进边界格**而不是被丢掉
  many.push(obj(defId, -3, -0.5));
  many.push(obj(defId, 19.5, 4));
  many.push(obj(defId, Number.NaN, 2), obj(defId, 1, Number.NaN));
  many.push(obj(defId, 16, 16));

  const dense = computeContentStats(many, { sizeX: 16, sizeZ: 16 });
  check(
    '分箱总数守恒：sum(bins.count) === totalObjects（越界物体被夹进边界格而不是丢弃）',
    binSum(dense.bins) === dense.totalObjects,
    `sum=${binSum(dense.bins)}，totalObjects=${dense.totalObjects}`,
  );
  check(
    'maxBinCount 等于实际最大的那个箱子',
    dense.maxBinCount === Math.max(...dense.bins.map((b) => b.count)),
    `maxBinCount=${dense.maxBinCount}`,
  );
  check(
    '分箱可以换尺寸（3 列 × 5 行）且仍然守恒',
    (() => {
      const custom = computeContentStats(many, { sizeX: 16, sizeZ: 16 }, { cols: 3, rows: 5 });
      return custom.bins.length === 15 && custom.binCols === 3 && custom.binRows === 5 && binSum(custom.bins) === custom.totalObjects;
    })(),
  );
  check(
    '非法 cols / rows（0 与负数）回落到默认 8×8，而不是产生 0 格或 NaN 格子',
    (() => {
      const bad = computeContentStats(many, { sizeX: 16, sizeZ: 16 }, { cols: 0, rows: -4 });
      return bad.binCols === 8 && bad.binRows === 8 && bad.bins.every((b) => Number.isFinite(b.x0) && Number.isFinite(b.x1));
    })(),
  );
  check(
    'cols = 0.5 也会回落（先取整再判大小，否则 16 / 0 会算出 Infinity 宽的格子）',
    (() => {
      const half = computeContentStats(many, { sizeX: 16, sizeZ: 16 }, { cols: 0.5 });
      return half.binCols === 8 && half.bins.every((b) => Number.isFinite(b.x0) && Number.isFinite(b.x1));
    })(),
  );

  // 边界：尺寸 8×8、8×8 格，坐标就是格子编号，最方便核对
  const onX = computeContentStats([obj(defId, 8, 0)], { sizeX: 8, sizeZ: 8 });
  check(
    '正好 x = sizeX：落在最后一列（第 7 列）而不是串到第 8 列 / 越界',
    onX.bins.length === 64 && onX.bins[7]?.count === 1 && binSum(onX.bins) === 1,
    `第 7 格=${onX.bins[7]?.count ?? 'n/a'}`,
  );
  const onZ = computeContentStats([obj(defId, 0, 8)], { sizeX: 8, sizeZ: 8 });
  check(
    '正好 z = sizeZ：落在最后一行（行 7，行主序 index = 7 * 8 = 56）',
    onZ.bins[56]?.count === 1 && binSum(onZ.bins) === 1,
    `第 56 格=${onZ.bins[56]?.count ?? 'n/a'}`,
  );
  const inside = computeContentStats([obj(defId, 7.999, 0)], { sizeX: 8, sizeZ: 8 });
  check(
    '刚刚小于 sizeX（7.999）也在最后一列，不会因为浮点跑到格子外',
    inside.bins[7]?.count === 1 && binSum(inside.bins) === 1,
  );
  const negative = computeContentStats([obj(defId, -0.001, -0.001)], { sizeX: 8, sizeZ: 8 });
  check(
    '负坐标（越界）被夹进第 0 格 —— 夹住会让边界格偏热，但丢掉会让总数对不上（取舍写在 binIndexOf 上）',
    negative.bins[0]?.count === 1 && binSum(negative.bins) === 1,
  );

  // origin：Engine 的世界以原点为中心，这条必须能用
  const centered = computeContentStats([obj(defId, -4, -4), obj(defId, 3.9, 3.9)], {
    sizeX: 8,
    sizeZ: 8,
    originX: -4,
    originZ: -4,
  });
  check(
    '传 originX / originZ 时按世界坐标分箱（-4..+4 的场景不会全挤到第 0 列）',
    centered.bins[0]?.count === 1 && centered.bins[63]?.count === 1 && binSum(centered.bins) === 2,
    `第 0 格=${centered.bins[0]?.count}，第 63 格=${centered.bins[63]?.count}`,
  );
  check(
    '不传 origin 时按 [0, sizeX) 解释（同一个物体落在别的格子里，口径没混）',
    (() => {
      const noOrigin = computeContentStats([obj(defId, -4, -4)], { sizeX: 8, sizeZ: 8 });
      return noOrigin.bins[0]?.count === 1 && binSum(noOrigin.bins) === 1;
    })(),
  );

  // ==================================================================
  // 5. 数量统计：top / 分类 / 二级分类 / 未知 id
  // ==================================================================

  if (defA && defB && defC) {
    const objects = [
      obj(defA.id, 1, 1),
      obj(defA.id, 2, 1),
      obj(defA.id, 3, 1),
      obj(defB.id, 1, 2),
      obj(defC.id, 1, 3),
      obj(defC.id, 2, 3),
      // 旧版本存档里才会出现的 id
      obj('legacy_unknown_model', 4, 3),
    ];
    const stats = computeContentStats(objects, { sizeX: 8, sizeZ: 8 });

    check('同一个 defId 出现 3 次：top 里 count === 3', stats.top[0]?.defId === defA.id && stats.top[0]?.count === 3, `${stats.top[0]?.defId} ×${stats.top[0]?.count}`);
    check('top 按数量降序', stats.top.every((item, i) => i === 0 || (stats.top[i - 1]?.count ?? 0) >= item.count), stats.top.map((t) => `${t.name}×${t.count}`).join('、'));
    check(
      'top 默认最多 10 条，topN 可调',
      computeContentStats(objects, { sizeX: 8, sizeZ: 8 }).top.length <= 10 &&
        computeContentStats(objects, { sizeX: 8, sizeZ: 8 }, { topN: 2 }).top.length === 2,
    );
    check(
      'top 里未知模型的 name 是"目录里查不到"的占位文案（不编造名字）',
      stats.top.some((item) => item.defId === 'legacy_unknown_model' && item.name.includes('查不到')),
      stats.top.find((item) => item.defId === 'legacy_unknown_model')?.name ?? '(没进 top)',
    );

    check('目录查不到的 defId 进 unknownIds', stats.unknownIds.includes('legacy_unknown_model'), stats.unknownIds.join('、'));
    check(
      '目录查不到的物体仍然计入 totalObjects 与分箱（静默丢弃会让总数对不上）',
      stats.totalObjects === 7 && binSum(stats.bins) === 7,
      `totalObjects=${stats.totalObjects}，sum=${binSum(stats.bins)}`,
    );
    check(
      'categories 按数量降序（3 / 2 / 1）',
      stats.categories.length === 3 &&
        stats.categories.every((item, i) => i === 0 || (stats.categories[i - 1]?.count ?? 0) >= item.count) &&
        stats.categories[0]?.category === catA &&
        stats.categories[0]?.count === 3,
      stats.categories.map((c) => `${c.category}${c.count}`).join(' > '),
    );
    check(
      'categories 的 ratio 口径是"占世界里全部物体的比例"',
      stats.categories.every((item) => Math.abs(item.ratio - item.count / stats.totalObjects) < 1e-12),
      stats.categories.map((c) => `${c.category} ${c.ratio.toFixed(3)}`).join('，'),
    );
    check(
      'categories 的 catalogCount 来自目录，不是世界里的数量',
      stats.categories.every((item) => item.catalogCount === BUILDING_CATALOG.filter((def) => def.category === item.category).length),
    );
    check(
      '查不到模型的物体没有分类可归，所以分类合计 < totalObjects（差额如实反映，不硬塞"未知"分类）',
      stats.categories.reduce((sum, item) => sum + item.count, 0) === stats.totalObjects - 1,
      `分类合计=${stats.categories.reduce((sum, item) => sum + item.count, 0)}，totalObjects=${stats.totalObjects}`,
    );
    check(
      'unusedCategories 是目录里有、世界里一个都没放的分类',
      stats.unusedCategories.length === categoriesInCatalog.length - 3 &&
        stats.unusedCategories.every((name) => !stats.categories.some((item) => item.category === name)),
      `${stats.unusedCategories.length} 个未使用：${stats.unusedCategories.join('、')}`,
    );
    check(
      'subcategories 的键是「一级 · 二级」复合名（同名二级分类不会被错误合并）',
      stats.subcategories.every((item) => item.category.includes(' · ')) &&
        stats.subcategories.every((item, i) => i === 0 || (stats.subcategories[i - 1]?.count ?? 0) >= item.count),
      stats.subcategories.map((s) => `${s.category}${s.count}`).join('、'),
    );
    check(
      'coverage = usedCatalogIds / totalCatalog',
      (() => {
        const expect = 3 / placeableTotal;
        return stats.usedCatalogIds === 3 && Math.abs(stats.coverage - expect) < 1e-12;
      })(),
      `used=${stats.usedCatalogIds} / ${stats.totalCatalog} = ${stats.coverage.toFixed(5)}`,
    );
    check(
      'usedCatalogIds 只数"出现过"的模型：同一个 defId 放 3 次只算 1 种',
      stats.usedCatalogIds === 3,
      `${stats.usedCatalogIds}`,
    );
  }

  // ==================================================================
  // 6. 规模：单趟统计不允许出现按 defId 的线性查找（这里是粗测，不是性能保证）
  // ==================================================================

  const big: PlacedObjectLike[] = [];
  const randBig = lcg(99);
  for (let i = 0; i < 5000; i += 1) {
    const def = BUILDING_CATALOG[Math.floor(randBig() * BUILDING_CATALOG.length)];
    big.push(obj(def?.id ?? defId, randBig() * 192, randBig() * 192));
  }
  const t0 = Date.now();
  const bigStats = computeContentStats(big, { sizeX: 192, sizeZ: 192 });
  const ms = Date.now() - t0;
  check('5000 个物体一次统计在 200 ms 内完成（粗测：单趟 + Map 查表的量级）', ms < 200, `${ms} ms`);
  check('5000 个物体同样守恒', binSum(bigStats.bins) === 5000 && bigStats.totalObjects === 5000, `sum=${binSum(bigStats.bins)}`);

  // ==================================================================
  // 7. UI 的健壮性：Node 里没有 document，这两条正好走"节点缺失"的降级路径
  // ==================================================================

  const stats = computeContentStats([obj(defId, 1, 1)], { sizeX: 8, sizeZ: 8 });

  check(
    'update(null) 不抛异常（节点全为 null 的降级路径 —— 接线还没完成时的真实情况）',
    (() => {
      const ui = new ContentStatsUI(null, null);
      try {
        ui.update(null);
        ui.update(stats);
        ui.setVisible(false);
        ui.setVisible(true);
        ui.dispose();
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check(
    'dispose() 之后 update() / setVisible() 不抛异常（只记录数据，不再画）',
    (() => {
      const ui = new ContentStatsUI(null, null);
      ui.dispose();
      try {
        ui.update(stats);
        ui.update(null);
        ui.setVisible(false);
        ui.dispose(); // 二次 dispose 也必须是安全的 no-op
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check(
    '统计结果里没有任何 NaN：面板上出现 NaN 是最难查的一类显示错误',
    (() => {
      const values = [
        stats.coverage,
        stats.totalCatalog,
        stats.totalObjects,
        stats.maxBinCount,
        stats.usedCatalogIds,
        ...stats.categories.flatMap((c) => [c.count, c.catalogCount, c.ratio]),
        ...stats.bins.flatMap((b) => [b.count, b.x0, b.z0, b.x1, b.z1]),
      ];
      return values.every((value) => Number.isFinite(value));
    })(),
  );

  // ==================================================================
  // 8. 绘制路径：用**假 DOM** 走一遍 canvas 与图例
  // ==================================================================
  //
  // 断言能做的和不能做的，这里必须说清楚：这**不是**浏览器渲染测试，
  // 它验证不了"画出来好不好看"，只能验证三件事：
  //   1. 绘制过程不抛异常（真跑起来才发现某个 ctx 方法名写错，代价太高）；
  //   2. 每一格都真的画了（该画 N 格就画 N 格，不多不少）；
  //   3. 拿不到数据时**没有**画格子，只画说明文字。
  // canvas 的位图尺寸按 dpr 放大这条也在这里验证（高分屏糊不糊只有它是可断言的）。

  const fake = installFakeDom(2);
  try {
    const legendLines = fake.legendLines;
    const ctx = fake.ctx;

    const ui = new ContentStatsUI(
      fake.canvas as unknown as HTMLCanvasElement,
      fake.legend as unknown as HTMLElement,
    );
    ui.update(stats);
    check(
      '高分屏：canvas 位图按 devicePixelRatio 放大（dpr=2 时 320×200 → 640×400）',
      fake.canvas.width === 640 && fake.canvas.height === 400,
      `${fake.canvas.width}×${fake.canvas.height}`,
    );
    check(
      '每一格都画了一次：格子矩形的数量 === bins 的数量',
      ctx.countRects(40, 25) === stats.bins.length,
      `矩形 ${ctx.countRects(40, 25)} 个 / 箱子 ${stats.bins.length} 个`,
    );
    check(
      '角落画了刻度与「最多 N 个/格」文字',
      ctx.fillTexts.some((text) => text.includes('最多')) && ctx.fillTexts.some((text) => text.includes('个/格')),
      ctx.fillTexts.filter((t) => t.includes('格')).join(' / '),
    );
    check(
      '图例写出了覆盖率与分类占比（占比保留 1 位小数）',
      legendLines.join('｜').includes('覆盖') && /占世界物体 \d+\.\d%/.test(legendLines.join('｜')),
      legendLines[0] ?? '(图例是空的)',
    );

    // 未知模型来自旧存档：图例必须单独醒目提示，而不是让它悄悄混在分类里
    const withUnknown = computeContentStats([obj(defId, 1, 1), obj('legacy_unknown_model', 2, 2)], {
      sizeX: 8,
      sizeZ: 8,
    });
    ctx.reset();
    ui.update(withUnknown);
    check(
      '图例把查不到的模型单独醒目提示（不是静默丢弃）',
      legendLines.some((text) => text.startsWith('⚠') && text.includes('查不到')),
      legendLines.find((text) => text.startsWith('⚠')) ?? '(没有这一行)',
    );

    // 全 0：必须画一层说明文字，而不是让玩家对着一块黑猜
    const zeroStats = computeContentStats([], { sizeX: 8, sizeZ: 8 });
    ctx.reset();
    ui.update(zeroStats);
    check(
      'maxBinCount === 0：画的是「还没有可统计的物体」说明文字（不是全黑，也不是"随便画几格"）',
      ctx.fillTexts.some((text) => text.includes('还没有可统计的物体')) && ctx.countRects(40, 25) === 64,
      ctx.fillTexts.join(' / '),
    );

    // 尺寸非法：一格都不许画
    ctx.reset();
    ui.update(zeroSize);
    check(
      '分箱不可用：一格都没画（只有底色），并且把原因写在了画布上',
      ctx.countRects(40, 25) === 0 &&
        ctx.fillRects.length === 1 &&
        ctx.fillTexts.some((text) => text.includes('分箱不可用')),
      `矩形 ${ctx.fillRects.length} 个，文字：${ctx.fillTexts.join(' / ')}`,
    );

    ctx.reset();
    ui.update(null);
    check(
      'update(null)：画布上显示「未统计」，一格都不画',
      ctx.fillTexts.some((text) => text.includes('未统计')) && ctx.countRects(40, 25) === 0,
      ctx.fillTexts.join(' / '),
    );

    check(
      'dpr 被夹在 3 以内（8x 屏不会白烧 8 倍像素）',
      (() => {
        const hi = installFakeDom(8);
        try {
          void new ContentStatsUI(hi.canvas as unknown as HTMLCanvasElement, null);
          return hi.canvas.width === 960; // 320 * 3
        } finally {
          hi.uninstall();
        }
      })(),
    );

    ui.dispose();
    check(
      'dispose() 摘掉了 window 上的 resize 监听（不是只置一个 flag）',
      fake.windowRemoved.includes('resize'),
      `摘掉：${fake.windowRemoved.join('、') || '(没有)'}`,
    );
  } finally {
    fake.uninstall();
  }

  // ==================================================================
  // 9. 内容包面板（`src/ui/ContentPackUI.ts`）
  // ==================================================================
  //
  // 它和统计共用一套"假 DOM + 假 localStorage"的做法。这里验证的是**契约**而不是外观：
  // 开关有没有真的写进 localStorage、回调有没有带上正确的集合、
  // 以及那句"关包不会删东西"的说明有没有出现在界面上（那句话是玩家敢不敢点开关的前提）。

  const packDom = installPackFakeDom();
  try {
    const calls: Set<string>[] = [];
    const packUI = new ContentPackUI(packDom.container as unknown as HTMLElement, {
      onPacksChange: (enabled) => calls.push(new Set(enabled)),
    });

    const rows = packDom.container.children.slice(0, CONTENT_PACKS.length);
    const rowText = (index: number): string => (rows[index] ? packDom.collectText(rows[index]) : '');
    const counts = packCounts(BUILDING_CATALOG);
    const vehicleIndex = CONTENT_PACKS.findIndex((pack) => pack.id === 'vehicle');

    check(
      '内容包面板渲染出 5 个包，名称与图标都来自 contentPacks.ts',
      rows.length === CONTENT_PACKS.length &&
        CONTENT_PACKS.every((pack, i) => rowText(i).includes(`${pack.emoji} ${pack.name}`)),
      `渲染 ${rows.length} 行`,
    );
    check(
      '每个包都列出了它包含的一级分类与本包项数',
      CONTENT_PACKS.every((pack, i) => rowText(i).includes(pack.categories.join('、')) && rowText(i).includes(`本包 ${counts[pack.id]} 项`)),
      rowText(0),
    );
    check(
      '未启用的包标出「开启后目录里会多出 N 个物品」，且 N 等于当前被隐藏的项数',
      vehicleIndex >= 0 &&
        rowText(vehicleIndex).includes(`开启后目录里会多出 ${counts.vehicle} 个物品`),
      rowText(vehicleIndex),
    );
    check(
      '已启用的包标「已启用」，不显示一个会误导人的"会多出 0 个"',
      rowText(0).includes('已启用'),
      rowText(0),
    );
    check(
      '面板上写清了"关掉内容包不会影响世界里已放置的物体"',
      packDom.collectText(packDom.container).includes('不会被删除'),
    );
    check(
      '摘要行与 describePacks() 完全一致（面板不自己拼第二份数字）',
      (() => {
        const expected = describePacks(defaultEnabledPacks(), BUILDING_CATALOG);
        return packDom.container.children.some((child) => child.textContent === expected);
      })(),
    );

    // 勾选交通包：必须落盘 + 回调，且集合里带上 vehicle
    const vehicleInput = packDom.lastElement('input', (el) => el.dataset.packId === 'vehicle');
    if (vehicleInput) vehicleInput.checked = true;
    packDom.dispatch('change', vehicleInput);
    check(
      '勾选交通包：写进 localStorage 并回调 onPacksChange（含 vehicle）',
      vehicleInput !== null &&
        calls.length === 1 &&
        calls[0]?.has('vehicle') === true &&
        (packDom.store.get(CONTENT_PACK_STORAGE_KEY) ?? '').includes('vehicle'),
      `回调 ${calls.length} 次，存储=${packDom.store.get(CONTENT_PACK_STORAGE_KEY) ?? '(空)'}`,
    );

    // DOM 被改过 / 旧版页面残留：未知包 id 不许写进状态
    const bogus = packDom.makeElement('input');
    bogus.type = 'checkbox';
    bogus.checked = true;
    bogus.dataset.packId = 'not_a_real_pack';
    packDom.dispatch('change', bogus);
    check(
      '未知包 id 的复选框被忽略（不写状态、不回调）—— 只认 contentPacks.ts 里存在的包',
      calls.length === 1 && !(packDom.store.get(CONTENT_PACK_STORAGE_KEY) ?? '').includes('not_a_real_pack'),
      `回调 ${calls.length} 次`,
    );

    // 批量按钮
    const clickAction = (action: string): void => {
      const button = packDom.lastElement('button', (el) => el.dataset.packAction === action);
      packDom.dispatch('click', button);
    };
    clickAction('all');
    const allEnabled = calls[calls.length - 1];
    check(
      '「全部启用」→ 回调收到全部 5 个包',
      allEnabled?.size === CONTENT_PACKS.length,
      `${allEnabled?.size ?? 'n/a'} 个：${[...(allEnabled ?? [])].join('、')}`,
    );
    clickAction('default');
    const restored = calls[calls.length - 1];
    check(
      '「恢复默认」→ 回调集合与 defaultEnabledPacks() 完全一致',
      restored !== undefined &&
        restored.size === defaultEnabledPacks().size &&
        [...defaultEnabledPacks()].every((id) => restored.has(id)),
      `${[...(restored ?? [])].join('、')}（默认应为 ${[...defaultEnabledPacks()].join('、')}）`,
    );
    check(
      '批量动作也会写进 localStorage（否则刷新页面就回到旧状态）',
      (packDom.store.get(CONTENT_PACK_STORAGE_KEY) ?? '').includes('base'),
      packDom.store.get(CONTENT_PACK_STORAGE_KEY) ?? '(空)',
    );

    const callsBeforeDispose = calls.length;
    packUI.dispose();
    packDom.dispatch('click', packDom.lastElement('button', (el) => el.dataset.packAction === 'all'));
    check(
      'dispose() 之后容器被清空，且再点按钮不会触发回调（监听真的摘掉了）',
      packDom.container.children.length === 0 && calls.length === callsBeforeDispose,
      `子节点 ${packDom.container.children.length} 个，回调 ${calls.length} 次`,
    );
  } finally {
    packDom.uninstall();
  }
}

// ---------------------------------------------------------------------------
// 假 DOM：只实现 `ContentStatsUI` 真正用到的那几个成员。
// 不用 jsdom —— 项目不允许新增依赖，而这里要验证的东西窄到几十行就能覆盖。
// ---------------------------------------------------------------------------

interface FakeCtx {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
  fillRects: [number, number, number, number][];
  fillTexts: string[];
  reset(): void;
  /** 尺寸正好是 (w, h) 的矩形画了几次 —— 用来数"画了几格" */
  countRects(w: number, h: number): number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

interface FakeEl {
  style: Record<string, string>;
  textContent: string;
  appendChild(child: FakeEl): void;
}

interface FakeDom {
  ctx: FakeCtx;
  canvas: { clientWidth: number; clientHeight: number; width: number; height: number; style: Record<string, string>; getContext(type: string): unknown };
  legend: FakeEl;
  legendLines: string[];
  windowRemoved: string[];
  uninstall(): void;
}

function installFakeDom(dpr: number): FakeDom {
  const fillRects: [number, number, number, number][] = [];
  const fillTexts: string[] = [];

  const ctx: FakeCtx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
    fillRects,
    fillTexts,
    reset(): void {
      fillRects.length = 0;
      fillTexts.length = 0;
    },
    countRects(w: number, h: number): number {
      return fillRects.filter((rect) => rect[2] === w && rect[3] === h).length;
    },
    setTransform(): void {},
    clearRect(): void {},
    fillRect(x, y, w, h): void {
      fillRects.push([x, y, w, h]);
    },
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {},
    fillText(text): void {
      fillTexts.push(text);
    },
    // 中文逐字折行要用它量宽度：粗略按"每字 6px"估，够本断言用
    measureText(text: string): { width: number } {
      return { width: text.length * 6 };
    },
  };

  const canvas = {
    clientWidth: 320,
    clientHeight: 200,
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext(): unknown {
      return ctx;
    },
  };

  const legendLines: string[] = [];
  let legendText = '';
  const legend: FakeEl = {
    style: {} as Record<string, string>,
    get textContent(): string {
      return legendText;
    },
    set textContent(value: string) {
      legendText = value;
      legendLines.length = 0;
    },
    appendChild(child: FakeEl): void {
      legendLines.push(child.textContent);
    },
  };

  const windowRemoved: string[] = [];
  const fakeWindow = {
    devicePixelRatio: dpr,
    addEventListener(): void {},
    removeEventListener(type: string): void {
      windowRemoved.push(type);
    },
  };

  const globals = globalThis as unknown as { document?: unknown; window?: unknown };
  const prevDocument = globals.document;
  const prevWindow = globals.window;
  globals.document = {
    createElement(): FakeEl {
      return { style: {} as Record<string, string>, textContent: '', appendChild(): void {} };
    },
  };
  globals.window = fakeWindow;

  return {
    ctx,
    canvas,
    legend,
    legendLines,
    windowRemoved,
    uninstall(): void {
      globals.document = prevDocument;
      globals.window = prevWindow;
    },
  };
}

// ---------------------------------------------------------------------------
// 假 DOM（内容包面板用）：比上面那套多一点东西 —— 需要 dataset / checked /
// addEventListener / closest，因为要真的"点一下开关"并检查回调。
// 同样不是浏览器渲染测试：它验证的是契约（写盘、回调、忽略非法输入），不是外观。
// ---------------------------------------------------------------------------

type StubHandler = (ev: { target: unknown }) => void;

interface StubEl {
  tag: string;
  style: Record<string, string>;
  textContent: string;
  className: string;
  title: string;
  type: string;
  checked: boolean;
  dataset: Record<string, string>;
  children: StubEl[];
  appendChild(child: StubEl): void;
  addEventListener(type: string, handler: StubHandler): void;
  removeEventListener(type: string, handler: StubHandler): void;
  closest(selector: string): StubEl | null;
  /** 断言用：把事件派发给这个节点上登记的监听器 */
  emit(type: string, ev: { target: unknown }): void;
}

function stubElement(tag: string): StubEl {
  const children: StubEl[] = [];
  const listeners = new Map<string, StubHandler[]>();
  let text = '';
  let self: StubEl;
  self = {
    tag,
    style: {},
    className: '',
    title: '',
    type: '',
    checked: false,
    dataset: {},
    children,
    get textContent(): string {
      return text;
    },
    set textContent(value: string) {
      text = value;
      children.length = 0; // 与浏览器一致：写 textContent 会清掉子节点
    },
    appendChild(child: StubEl): void {
      children.push(child);
    },
    addEventListener(type: string, handler: StubHandler): void {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type: string, handler: StubHandler): void {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    closest(selector: string): StubEl | null {
      return selector === tag ? self : null;
    },
    emit(type: string, ev: { target: unknown }): void {
      for (const handler of listeners.get(type) ?? []) handler(ev);
    },
  };
  return self;
}

interface PackFakeDom {
  container: StubEl;
  /** localStorage 的替身：Map 就够，我们要看的只是"有没有写进去、写了什么" */
  store: Map<string, string>;
  collectText(el: StubEl): string;
  /** 后创建的那个匹配节点（刷新会重建 DOM，所以永远取最新的） */
  lastElement(tag: string, predicate: (el: StubEl) => boolean): StubEl | null;
  makeElement(tag: string): StubEl;
  dispatch(type: string, target: StubEl | null): void;
  uninstall(): void;
}

function installPackFakeDom(): PackFakeDom {
  const created: StubEl[] = [];
  const globals = globalThis as unknown as { document?: unknown; localStorage?: unknown };
  const prevDocument = globals.document;
  const prevStorage = globals.localStorage;

  globals.document = {
    createElement(tag: string): StubEl {
      const el = stubElement(tag);
      created.push(el);
      return el;
    },
  };

  const store = new Map<string, string>();
  globals.localStorage = {
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };

  const container = stubElement('div');
  const collectText = (el: StubEl): string =>
    [el.textContent, ...el.children.map((child) => collectText(child))].filter((part) => part !== '').join('｜');

  return {
    container,
    store,
    collectText,
    lastElement(tag: string, predicate: (el: StubEl) => boolean): StubEl | null {
      for (let i = created.length - 1; i >= 0; i -= 1) {
        const el = created[i];
        if (el && el.tag === tag && predicate(el)) return el;
      }
      return null;
    },
    makeElement(tag: string): StubEl {
      const el = stubElement(tag);
      created.push(el);
      return el;
    },
    dispatch(type: string, target: StubEl | null): void {
      container.emit(type, { target });
    },
    uninstall(): void {
      globals.document = prevDocument;
      globals.localStorage = prevStorage;
    },
  };
}
