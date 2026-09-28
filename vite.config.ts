import { defineConfig } from 'vite';

/**
 * GitHub Pages 子路径（base）解析顺序：
 *
 * 1. 环境变量 `VITE_BASE` 显式覆盖，例如：
 *      VITE_BASE=/my-repo/ npm run build
 * 2. GitHub Actions 环境：自动读取 `GITHUB_REPOSITORY`（形如 owner/repo），
 *    取仓库名作为子路径。**仓库改名不用改代码**。
 * 3. 兜底：本地开发/本地构建使用下面的 DEFAULT_REPO。
 *
 * 注意：base 同时作用于 `npm run dev` 与 `npm run preview`，所以本地要用
 * 子路径访问：
 *      dev     → http://localhost:5173/god-sandbox/
 *      preview → http://localhost:4173/god-sandbox/
 * 这样和线上 GitHub Pages 的路径行为完全一致，避免"本地能跑、线上白屏"。
 */
const DEFAULT_REPO = 'gad-box';

function resolveBase(): string {
  const explicit = process.env.VITE_BASE;
  if (explicit) {
    return explicit.endsWith('/') ? explicit : `${explicit}/`;
  }
  const fromCI = process.env.GITHUB_REPOSITORY?.split('/')[1];
  const repo = fromCI || DEFAULT_REPO;
  return `/${repo}/`;
}

export default defineConfig({
  base: resolveBase(),
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /**
         * M3：把 rapier 那个 4.3 MB 的 chunk 输出成**固定名字** `assets/rapier.js`。
         *
         * 为什么需要这个：物理引擎的 wasm 是以 base64 内联在这个 chunk 里的，
         * 而 `import()` 不提供任何下载进度回调。给它一个**可预测的 URL**之后，
         * `RapierWorldManager` 就能先 `fetch()` 一次、读 `Content-Length` 与流式分片，
         * 算出真实百分比，随后的 `import()` 命中 HTTP 缓存、不会重复下载。
         *
         * 代价：这个 chunk 不再带内容 hash，浏览器缓存要靠 HTTP 缓存头（Vite preview
         * 与 GitHub Pages 都会发 ETag/Last-Modified），改版本后需要正常的一次重新验证。
         * 换来的是加载时**看得见的真实进度**，值。
         *
         * 如果以后改了这里，记得同步 `src/physics/RapierWorld.ts` 的 `RAPIER_CHUNK_FILE`。
         */
        chunkFileNames: (chunk) =>
          chunk.name === 'rapier' ? 'assets/rapier.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
