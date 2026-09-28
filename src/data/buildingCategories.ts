import { BUILDING_CATALOG } from './buildingCatalog';

/** 建筑分类的展示信息 */
export interface BuildingCategoryInfo {
  id: string;
  name: string;
  icon: string;
  description: string;
}

/**
 * 分类展示顺序与图标。
 *
 * 顺序是刻意的：从"搭房子最常用的结构件"开始，到"玩票性质的奇幻物件"结束，
 * 这样物品面板第一页就是玩家最需要的东西。
 */
export const BUILDING_CATEGORIES: readonly BuildingCategoryInfo[] = [
  { id: '结构', name: '结构', icon: '🧱', description: '墙、地板、柱、梁、楼梯等承重构件' },
  { id: '门窗', name: '门窗', icon: '🚪', description: '各种门与窗，用来给房间开口' },
  { id: '家具', name: '家具', icon: '🪑', description: '桌椅床柜等室内陈设' },
  { id: '电器', name: '电器', icon: '💡', description: '灯具、屏幕、家电' },
  { id: '厨卫', name: '厨卫', icon: '🚿', description: '厨房与卫浴设施' },
  { id: '装饰', name: '装饰', icon: '🖼️', description: '地毯、画、雕塑、喷泉等点缀' },
  { id: '交通', name: '交通', icon: '🚗', description: '车、船、火车等载具模型' },
  { id: '机械', name: '机械', icon: '⚙️', description: '齿轮、活塞、传送带、工程机械' },
  { id: '奇幻', name: '奇幻', icon: '✨', description: '传送门、水晶、浮空石等' },
  // M4 新增两个一级分类：小物品与植物小件。
  // 为什么不并进「装饰」：它们的定位完全不同 —— 装饰是"给房间加点东西"，
  // 小物品是"能拿在手里、能摆在桌上的东西"，植物是"活的、会摆动的"。混在一起
  // 玩家在面板里翻的时候会找不到（300 个物品的分类必须能一眼定位）。
  { id: '小物品', name: '小物品', icon: '🧸', description: '杯子、书、工具、玩具等能拿在手里的小东西' },
  { id: '植物', name: '植物', icon: '🪴', description: '盆栽、多肉、花卉、藤蔓与小树' },
] as const;

/** 每个分类实际有多少个模型 */
export function categoryCounts(): Map<string, number> {
  const map = new Map<string, number>();
  for (const def of BUILDING_CATALOG) {
    map.set(def.category, (map.get(def.category) ?? 0) + 1);
  }
  return map;
}

/** 实际存在模型的分类列表（按 BUILDING_CATEGORIES 的顺序） */
export function usedCategories(): BuildingCategoryInfo[] {
  const counts = categoryCounts();
  return BUILDING_CATEGORIES.filter((info) => (counts.get(info.id) ?? 0) > 0);
}

/** 分类图标（找不到时给个默认值） */
export function categoryIcon(id: string): string {
  return BUILDING_CATEGORIES.find((info) => info.id === id)?.icon ?? '📦';
}
