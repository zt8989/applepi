/**
 * Node 服务端 —— 浏览器侧的环跑在这里。
 *
 * 架构上只有**一个**权威内核（`createKernel()` 造出来的那个 store）。浏览器不跑环，
 * 它只做两件事：
 *
 *   - `GET  /api/events`  SSE：订阅状态树。任何变化都推一帧完整状态。
 *   - `POST /api/message` 发一句话 → dispatch 进环。
 *   - `POST /api/abort`   中断当前回合。
 *   - `GET  /api/snapshot` 首次进入时拿一份全量状态（比等 SSE 首帧更简单可靠）。
 *
 * 为什么要 SSE 而不是 WebSocket：这个方向是**纯服务端推送**（浏览器只发不读），
 * SSE 走普通 HTTP，浏览器自带断线重连，服务端零依赖。双向那条路（发消息）用 POST 就够。
 *
 * 推「完整状态」而不是增量：状态树本身不大（消息 + 轨迹节点），而增量要处理
 * 「客户端漏帧」的问题。序列化成字符串再量过 —— 超过阈值才提醒。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createKernel, defaultSystemPrompt, type Kernel, type KernelOptions } from './kernel';
import { defaultProviderSpec } from './provider';
import { abortRun } from './run-control';
import { getTools } from './tools';
import { traceStats } from './trace';
import { providerNames } from './provider';
import type { AgentState } from './state';

/** 推给浏览器的状态快照。刻意只挑界面要用的字段。 */
export interface Snapshot {
  type: 'snapshot';
  phase: AgentState['phase'];
  systemPrompt: string;
  providerName: string;
  modelId: string;
  thinkingLevel: AgentState['thinkingLevel'];
  messages: AgentState['messages'];
  streamingText: string;
  thinkingText: string;
  streamSeq: number;
  turns: number;
  totalCost: number;
  usage: AgentState['usage'];
  error: string | null;
  errorKind: AgentState['errorKind'];
  errorNodeId: string | null;
  retrying: boolean;
  aborted: boolean;
  toolNames: readonly string[];
  // 轨迹树整棵给过去（界面要画 git log 那棵树）。
  trace: AgentState['trace'];
  sessionId: string;
  cwd: string;
  providers: readonly string[];
  /** 统计直接算好，省得浏览器重复实现一遍。 */
  stats: ReturnType<typeof traceStats>;
  /**
   * 内核是否需要 API key。demo / faux provider 不需要 —— 浏览器据此不弹 key 对话框
   * （pi-web-ui 的 sendMessage 会先查 key，缺了就调 onApiKeyRequired，弹窗会挡住发送）。
   */
  needsApiKey: boolean;
}

function snapshot(kernel: Kernel, cwd: string): Snapshot {
  const s = kernel.store.getState();
  return {
    type: 'snapshot',
    phase: s.phase,
    systemPrompt: s.systemPrompt,
    providerName: s.providerName,
    modelId: s.modelId,
    thinkingLevel: s.thinkingLevel,
    messages: s.messages,
    streamingText: s.streamingText,
    thinkingText: s.thinkingText,
    streamSeq: s.streamSeq,
    turns: s.turns,
    totalCost: s.totalCost,
    usage: s.usage,
    error: s.error,
    errorKind: s.errorKind,
    errorNodeId: s.errorNodeId,
    retrying: s.retrying,
    aborted: s.aborted,
    toolNames: s.toolNames,
    trace: s.trace,
    sessionId: kernel.sessionId,
    cwd,
    providers: providerNames(),
    stats: traceStats(s.trace),
    // faux（demo）不需要 key；其他 provider 由服务端从环境变量读，浏览器不用管。
    needsApiKey: s.providerName !== 'faux',
  };
}

/**
 * 生产模式下内核的默认端口。
 *
 * 生产（`npm run serve`）时内核自己发 `web/dist`，页面与 API 同源，所以 5273 就够。
 * 开发（`npm run web`）时 5273 归 vite，内核要让开 —— 那时用 `--port 5274`，
 * 由 vite 反向代理 `/api` 过来（见 web/vite.config.ts）。
 */
export const DEFAULT_PORT = 5273;
/** 开发时内核让给 vite 后用的端口。 */
export const DEV_KERNEL_PORT = 5274;

export interface ServerOptions extends Partial<KernelOptions> {
  port?: number | undefined;
  /** 静态文件目录（web/dist）。存在才提供页面。 */
  webRoot?: string | undefined;
}

export interface RunningServer {
  kernel: Kernel;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const kernel = createKernel({
    // provider / model / thinkingLevel 必须原样传下去：调用方（serve.ts）已经解析过默认值，
    // 这里再兜一次就会把用户选的模型悄悄换成别的（之前就漏了 model，害得默认回落成第一个模型）。
    ...defaultProviderSpec(),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    systemPrompt: options.systemPrompt ?? defaultSystemPrompt(),
    cwd,
    demo: options.demo,
    llmTimeoutMs: options.llmTimeoutMs,
    maxLlmAttempts: options.maxLlmAttempts,
    maxTurns: options.maxTurns,
    sessionId: options.sessionId,
    traceDir: options.traceDir,
    onTraceError: (error) => {
      process.stderr.write(`轨迹落盘失败：${String(error)}\n`);
    },
  });

  /** 所有 SSE 连接。状态一变就广播。 */
  const clients = new Set<http.ServerResponse>();

  // 流式 token 变化极快（每个 delta 一次）。攒一小会儿再推，避免每秒几百帧。
  let pending: NodeJS.Timeout | null = null;
  const broadcast = (): void => {
    if (clients.size === 0) return;
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const frame = `data: ${JSON.stringify(snapshot(kernel, cwd))}\n\n`;
      for (const client of clients) {
        // 断了就悄悄踢掉，下一帧自然会跳过。
        client.write(frame);
      }
    }, 40);
  };
  kernel.store.subscribe(broadcast);

  const webRoot = options.webRoot ?? path.resolve(cwd, 'web/dist');

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // ── SSE：订阅状态树 ──
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 关掉 nginx 之类的缓冲，否则事件会被攒住。
        'x-accel-buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(snapshot(kernel, cwd))}\n\n`);
      clients.add(res);
      // 心跳：有些代理会掐掉闲置连接。
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(beat);
        clients.delete(res);
      });
      return;
    }

    // ── 首次快照 ──
    if (url.pathname === '/api/snapshot') {
      sendJson(res, 200, snapshot(kernel, cwd));
      return;
    }

    // ── 发消息 ──
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const body = (await readJson(req)) as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        sendJson(res, 400, { error: '缺少 text' });
        return;
      }
      if (kernel.store.getState().phase !== 'idle') {
        sendJson(res, 409, { error: '上一回合还没结束' });
        return;
      }
      kernel.store.dispatch({ type: 'user.message', text });
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── 中断 ──
    if (url.pathname === '/api/abort' && req.method === 'POST') {
      sendJson(res, 200, { aborted: abortRun() });
      return;
    }

    // ── 换模型 ──
    if (url.pathname === '/api/model' && req.method === 'POST') {
      const body = (await readJson(req)) as { provider?: unknown; modelId?: unknown };
      if (typeof body.provider === 'string' && typeof body.modelId === 'string') {
        kernel.store.dispatch({
          type: 'model.changed',
          provider: body.provider,
          modelId: body.modelId,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 400, { error: '缺少 provider / modelId' });
      return;
    }

    // ── 新对话 ──
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      kernel.store.dispatch({ type: 'conversation.reset' });
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── 工具清单（界面展示用） ──
    if (url.pathname === '/api/tools') {
      sendJson(res, 200, {
        cwd,
        tools: getTools(cwd).map((t) => ({
          name: t.name,
          label: t.label,
          description: t.description,
        })),
      });
      return;
    }

    // ── 静态文件 ──
    if (req.method === 'GET' && existsSync(webRoot)) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      // 防目录穿越：解析后必须仍在 webRoot 之内。
      const file = path.resolve(webRoot, rel);
      if (file.startsWith(webRoot) && existsSync(file)) {
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        });
        res.end(body);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  const port = await listen(server, options.port ?? DEFAULT_PORT);
  return {
    kernel,
    port,
    async close(): Promise<void> {
      kernel.dispose();
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // 端口被占就自动往后找（--port 指定的端口则必须成功）。
    const tryPort = (p: number, attemptsLeft: number): void => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
          tryPort(p + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      });
      server.listen(p, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : p);
      });
    };
    tryPort(port, 10);
  });
}
