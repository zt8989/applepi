import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * 端口分工（别把它们设成同一个）：
 *
 *   5273  vite dev server —— 页面。`/api/*` 反向代理到内核。
 *   5274  Node 内核（src/server.ts）—— API 与 SSE。
 *
 * 为什么要代理：前端只用**相对路径** `/api/*`（见 remote-session.ts），它不知道内核在哪。
 * 开发时页面在 vite（5273）、内核在另一个进程（5274），所以必须由 vite 转发 ——
 * 浏览器始终只跟 5273 说话，同源，SSE 也不会被跨域挡掉。
 *
 * 生产（`npm run web:serve`）不需要代理：那时内核自己发 `web/dist`，
 * 页面和 API 同源，`npm run serve` 监听 5273。
 */
const KERNEL_PORT = Number(process.env['HARNESS_KERNEL_PORT'] ?? 5274);
const WEB_PORT = Number(process.env['HARNESS_WEB_PORT'] ?? 5273);

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      // SSE 必须关掉压缩与缓冲，否则事件会被攒住（内核侧也发心跳，两边都要）。
      "/api": {
        target: `http://127.0.0.1:${KERNEL_PORT}`,
        changeOrigin: true,
        // SSE 用流式转发，不能等结束。
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
            }
          });
        },
      },
    },
  },
  preview: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${KERNEL_PORT}`, changeOrigin: true },
    },
  },
});
