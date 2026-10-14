/**
 * tui 侧的 web server：一个 HTTP 静态服务器 + 一个 WebSocket 端点。
 *
 * ## 为什么服务端在 tui 里
 *
 * 环（`createKernel()`）只有一份，跑在 tui 进程里。webui 是**纯前端** —— 它不碰模型、
 * 不跑工具、不认识 `models.json`，只是一个渲染层。所以「服务端」不是另起一个 agent
 * 进程，而是**把已经在跑的那一个**接到浏览器上：
 *
 *   - `GET /`（及静态资源）→ `@ela/webui` 的构建产物（Vite 打的 dist）；
 *   - `GET /ws` → WebSocket，双向：[bridge](bridge.ts) 往外发状态/事件，浏览器往里发
 *     提问/中止/换模型。
 *
 * ## 默认只绑 127.0.0.1
 *
 * 这个端点能驱动一个**能跑任意命令**的 agent（工具没有沙箱，见架构文档）。绑到
 * `0.0.0.0` 就是把「以你的权限执行任意命令」挂到局域网上，且**没有任何认证**。
 * 所以默认 loopback；要暴露出去请自己用带认证的反向代理，且清楚上面那句话的含义。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type WebServerMessage, type WebClientMessage } from '@ela/core/web-protocol';
import type { WebBridge } from './bridge';

/** 默认端口：与 pi 的 web 客户端（`@agegr/pi-web`）同一个，撞上了也好认。 */
export const DEFAULT_WEB_PORT = 30141;

/** 端口被占时最多往后试几个。 */
const PORT_SCAN_LIMIT = 10;

export interface WebServerOptions {
  bridge: WebBridge;
  /** 监听端口。被占就往后试（见 `PORT_SCAN_LIMIT`）。 */
  port?: number | undefined;
  /** 绑定地址。默认 `127.0.0.1`（见文件头）。 */
  host?: string | undefined;
  /** 静态资源目录；不给就找 `@ela/webui` 的 dist。 */
  distDir?: string | undefined;
  /** 诊断输出（TUI 起来之前落到 stderr，起来之后由界面接）。 */
  log?: ((line: string) => void) | undefined;
}

export interface WebServerHandle {
  readonly port: number;
  readonly url: string;
  readonly distDir: string | undefined;
  close(): Promise<void>;
}

/** 找 `@ela/webui` 的 dist。返回 `undefined` = 还没构建（服务器照样起，给一页说明）。 */
export function resolveWebuiDist(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('@ela/webui/package.json');
    const dist = path.join(path.dirname(manifest), 'dist');
    return existsSync(path.join(dist, 'index.html')) ? dist : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一条连接最多允许压多少字节还没发出去。
 *
 * ## 为什么必须有上限
 *
 * `ws.send()` **不等对端**：写不出去（浏览器那侧慢一点）就先堆在 `bufferedAmount` 里。
 * 而状态帧是 O(整段会话) 的 —— 一份 4MB 的状态乘上几十帧就是 GB 级，最终在服务端
 * 变成 `FATAL ERROR: heap out of memory`（真发生过：堆 2.6GB→4.35GB 撞上限 abort）。
 * 且这条路径**与 TUI 同一个进程**，所以堆积的不只是内存，还有 TUI 的响应。
 *
 * 超了就**丢旧的**，而不是无限顿：
 *   - `state` 是可覆盖的（下一帧就是最新真相），只留最后一份；
 *   - `event` 小、且部分不可重放（`message_end` / `agent_end`），按序留着，但给个上限。
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** 排空试探间隔。没有 `drain` 回调可等（`ws` 不转发它），一个短定时器就够。 */
const DRAIN_RETRY_MS = 100;

/** 压着的事件最多留这么多条，超了丢最老的（宁可少几帧流式更新，也不要无限长）。 */
const MAX_QUEUED_EVENTS = 256;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

/** 还没构建时的占位页 —— 起得来、说得清，比 404 强。 */
const PLACEHOLDER = `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>ela web ui</title>
<body style="font:14px/1.6 ui-sans-serif,system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem">
<h1>webui 还没构建</h1>
<p>前端包 <code>@ela/webui</code> 的 <code>dist/</code> 不存在。先构建一次：</p>
<pre><code>pnpm build</code></pre>
<p>构建完刷新本页即可。会话/环都在服务端（tui 进程里）跑着，不受影响。</p>
</body>
</html>
`;

function serveStatic(res: ServerResponse, distDir: string | undefined, pathname: string): void {
  if (distDir === undefined) {
    res.writeHead(200, { 'content-type': MIME['.html']! });
    res.end(PLACEHOLDER);
    return;
  }
  // SPA 口径：没有扩展名或找不到就回 index.html（前端自己按路径渲染）。
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(distDir, relative);
  const inDist = candidate === distDir || candidate.startsWith(`${distDir}${path.sep}`);
  const file =
    inDist && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : path.join(distDir, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // 开发时改了前端要立刻看到 —— 这些资源不带 hash，缓存没有意义。
    'cache-control': 'no-store',
  });
  res.end(readFileSync(file));
}

/** 起服务器。端口被占就往后试；全被占就抛（调用方决定要不要让 TUI 照常起）。 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const distDir = options.distDir ?? resolveWebuiDist();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}`}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok\n');
      return;
    }
    serveStatic(res, distDir, decodeURIComponent(url.pathname));
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, options.bridge);
    });
  });

  const port = await listenWithScan(server, host, options.port ?? DEFAULT_WEB_PORT);
  const url = `http://${host}:${port}/`;
  if (distDir === undefined) {
    log(`[webui] 前端还没构建：${url} 会显示一页说明（跑 \`pnpm build\` 生成 dist）`);
  } else {
    log(`[webui] ${url}`);
  }

  return {
    port,
    url,
    distDir,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close(() => {
          server.close(() => resolve());
        });
      }),
  };
}

/**
 * 一条 WebSocket 连接 = 一个订阅者。
 *
 * ## 发送带背压
 *
 * 直接 `ws.send(JSON.stringify(...))` 在「浏览器跟不上」时会把内存吃干（见
 * `MAX_BUFFERED_BYTES`）。所以这里加一层小队列：
 *
 *   - 通畅时**直发**（不多一次 `setTimeout`，也就不给正常路径添延迟）；
 *   - 堵了就把帧压进队列：`state` 覆盖式替换（只留最新），`event` 按序追加；
 *   - 排空后**先补最新的 state，再按序补事件** —— 与协议「先状态后事件」一致，
 *     也正因为状态是整份快照，丢掉中间那几帧不会漂移。
 */
function attach(ws: WebSocket, bridge: WebBridge): void {
  /** 压着还没发的状态：只留最新一份（旧的被下一份覆盖）。 */
  let queuedState: WebServerMessage | undefined;
  /** 压着还没发的事件：按序，但有限长。 */
  const queuedEvents: WebServerMessage[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** 现在能写吗（连接还在 + 没积压到上限）。 */
  const canSend = (): boolean =>
    ws.readyState === ws.OPEN && ws.bufferedAmount <= MAX_BUFFERED_BYTES;

  const scheduleRetry = (): void => {
    if (retryTimer !== undefined || ws.readyState !== ws.OPEN) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      flushQueued();
    }, DRAIN_RETRY_MS);
    retryTimer.unref?.();
  };

  const flushQueued = (): void => {
    if (ws.readyState !== ws.OPEN) return;
    if (!canSend()) {
      scheduleRetry();
      return;
    }
    const state = queuedState;
    queuedState = undefined;
    const events = queuedEvents.splice(0, queuedEvents.length);
    if (state !== undefined) ws.send(JSON.stringify(state));
    for (const event of events) ws.send(JSON.stringify(event));
    if (queuedState !== undefined || queuedEvents.length > 0) scheduleRetry();
  };

  const send = (message: WebServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    // 通畅且队列空 → 直发；否则进队列（顺序由队列保证）。
    if (canSend() && queuedState === undefined && queuedEvents.length === 0) {
      ws.send(JSON.stringify(message));
      return;
    }
    if (message.type === 'state') {
      queuedState = message;
    } else {
      queuedEvents.push(message);
      // 丢最老的：留下的是「最近的几件事」，而它们才是界面还在等的那几条。
      if (queuedEvents.length > MAX_QUEUED_EVENTS) queuedEvents.shift();
    }
    scheduleRetry();
  };

  send(bridge.hello());

  const unsubscribe = bridge.subscribe(send);
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : data.toString('utf8');
    const message: WebClientMessage | undefined = parseClientMessage(text);
    if (message === undefined) return;
    for (const reply of bridge.handle(message)) send(reply);
  });
  ws.on('close', () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    unsubscribe();
  });
  ws.on('error', unsubscribe);
}

/**
 * 端口扫描。
 *
 * 为什么不是「占用了就报错退出」：web server 是**附带**功能，TUI 才是主界面。
 * 一个被别的进程占着的端口不该让 `ela` 起不来；而静默失败更糟 —— 用户会一直刷
 * 一个打不开的地址，还以为是自己网络的问题。所以换端口并把真地址报出来。
 */
function listenWithScan(server: Server, host: string, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && attempt < PORT_SCAN_LIMIT) {
          attempt += 1;
          tryListen(port + 1);
          return;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryListen(preferred);
  });
}