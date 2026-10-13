import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * webui 的构建。
 *
 * `base: '/'`（默认）—— 由 tui 的 web server 从根路径供静态资源（见 `web/server.ts`）。
 * 产物落在 `dist/`，`@ela/tui` 通过 `@ela/webui/package.json` 推出来的路径找它。
 */
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // pdfjs / xlsx 这些大件是 pi-web-ui 的依赖；默认 500KB 的告警没有信息量。
    chunkSizeWarningLimit: 4000,
  },
});