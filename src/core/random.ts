/**
 * 可复现的伪随机数发生器。
 *
 * 单独成文件的原因：地形生成（voxel/）与未来的世界生成都可能用到它，
 * 但它不属于 World 的实例状态；放这里可以避免 voxel → core/World 的循环依赖。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
