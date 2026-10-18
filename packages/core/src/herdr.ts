/**
 * herdr 集成 —— 让 herdr 的 sidebar / `agent list` 认出这个 pane 里跑的是 pi。
 *
 * ## 为什么必须**自己上报**，而不是往进程环境里塞 `HERDR_AGENT`
 *
 * herdr 认 pane 里的 agent，靠的是**前台进程身份**（进程名 / argv）。ela 的进程是
 * `node …/bin/ela.mjs` —— herdr 既不认识 `ela`，也看不出这是 pi 家族。
 *
 * herdr 为此给过一个提示变量 `HERDR_AGENT=<agent>`（包装进程用），但那个**只在
 * Linux / macOS 生效**：官方文档 *Agents → VMs and sandbox wrappers* 一节明写
 * “On Linux and macOS, a host-visible wrapper can hide the real agent process…”，
 * 而 Windows 那份 `herdr.exe` 里连 `HERDR_AGENT` 这个字符串都不存在（那段逻辑是
 * `cfg(unix)` 的）。于是 `bin/ela.mjs` 里那次「带 `HERDR_AGENT` 再 exec 一遍自己」
 * 在 Windows 上纯属白干 —— 变量确实进了进程环境（`ps` / 子进程都看得见），herdr 却
 * 从来不读它，pane 依旧没有身份。
 *
 * 跨平台的正确路子是 herdr 文档里的 *Add Herdr support to your agent*：agent 自己
 * 上报。这也是 herdr 官方 pi 集成（`herdr:pi`）在做的事 —— 只是它的上报者是**真的
 * pi 进程**且只在 `ctx.mode === 'tui'` 时开工，本项目这边指望不上。
 *
 * ## 报什么、报给谁
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 传输 | `HERDR_SOCKET_PATH` 上的 socket（一行一个 JSON 请求） |
 * | 方法 | `pane.report_agent`（状态 + 会话引用 + resume 命令）、`pane.release_agent` |
 * | agent | `pi`（可被 `ELA_HERDR_AGENT` 覆盖，见 `herdrAgentName`） |
 * | source | `ela`（herdr 自己那套用 `herdr:` 前缀，第三方不许撞） |
 *
 * 会话引用报**本项目自己那份**：`sessions/<cwd>/<时间戳>_<id>.jsonl`（与 pi 同形状，
 * 见 config-home.ts），resume 命令是 `ela --session <id>` —— 于是 herdr 服务器重启后
 * 拉起来的是 ela 自己，而不是一个没有 ela 状态的 pi 进程。
 *
 * ## 为什么不 spawn `HERDR_BIN_PATH` 那套 CLI
 *
 * 官方推荐 CLI（“the portable choice, including on Windows”），但每次状态变化起一个
 * 27MB 的 herdr 进程、还带一个控制台 —— 而状态变化是**每轮对话好几次**。
 * socket 是 herdr 自己的 pi 扩展走的那条路（同一份 `pane.report_agent` 协议），
 * 实测在 Windows 上可用（Windows 的 socket 是**命名管道**，见 `herdrSocketEndpoint`）。
 *
 * ## 失败面：报不上不算错
 *
 * herdr 不在（变量不全）、socket 连不上、herdr 回一个错误 —— 一律**吞掉不抛**，
 * 对话该怎么跑还怎么跑；第一次失败会通过 `onError` 说一声（只说一次，免得刷屏）。
 * 这与 herdr 文档给集成作者的要求一致（“Send reports in the background or with a
 * short timeout, and ignore failures.”）。
 *
 * ## 退出时不靠 release 兜底
 *
 * 正常收工（`ela -p` 走完、TUI 的 finally）会发一条 `pane.release_agent`；而
 * Ctrl+D / Ctrl+C 那条路径上是 `process.exit()` —— 异步 socket 写不出去，发也白发。
 * 那不要紧：herdr 自己会发现「上报那个进程没了」并把 pane 清掉（实测 3 秒内，
 * 也是官方集成唯一的退出方式 —— 它压根不发 release）。所以 `dispose()` 只管停掉
 * 订阅，别指望它让 pane 立刻变干净。
 */
import { createConnection } from 'node:net';
import type { AgentState } from './state';
import type { AgentStore } from './store';

/** herdr 认的三种 agent 状态（它还有一个 `unknown`，那是「认出来了但判不出」用的，不该由我们报）。 */
export type HerdrAgentState = 'idle' | 'working' | 'blocked';

/** 默认报给 herdr 的 agent 名。ela 的界面与状态上报都走 pi 那一套，所以默认就是 `pi`。 */
export const HERDR_AGENT_NAME = 'pi';

/** `--source`：herdr 用它区分「谁在管这个 pane」。不能以 `herdr:` 开头（那是它自己的）。 */
export const HERDR_SOURCE = 'ela';

/** 换身份（或关掉）的开关。与 `bin/ela.mjs` 里那个旧 hint 同名，语义也接得上。 */
export const HERDR_AGENT_ENV = 'ELA_HERDR_AGENT';

/**
 * 问卷工具的注册名。
 *
 * 它挂在 `state.executing` 上时**就是**「模型在等你答」——问卷在终端浮层/浏览器上
 * 等答案，那个工具调用不结束（`reducer` 的 `tool/start` 把它放进 `executing`，
 * `tool.result` 才拿掉）。这是本项目里**唯一**一种「等用户」的状态，所以也就是
 * 唯一该报 `blocked` 的时刻。
 */
const ASK_USER_QUESTION = 'ask_user_question';

/** `blocked` 时给 herdr 看的那句话（它显示在 sidebar 的 agent 行上）。 */
const BLOCKED_MESSAGE = '等待你回答问卷';

/** herdr pane 的身份：报给谁、报给哪一条 socket。 */
export interface HerdrPane {
  readonly paneId: string;
  readonly socketPath: string;
}

/**
 * 该报哪个 agent 名。
 *
 * `undefined` = **不上报**：`ELA_HERDR_AGENT` 被显式关掉（`off` / `0` / 空串）时，
 * 用户要的是「别管这个 pane」，那就不该只是「换个名字接着报」。
 */
export function herdrAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const requested = env[HERDR_AGENT_ENV];
  if (requested === 'off' || requested === '0' || requested === '') return undefined;
  return requested ?? HERDR_AGENT_NAME;
}

/**
 * 从环境变量读 herdr 的 pane 身份；不在 herdr 里（变量不全）→ `undefined`。
 *
 * 判据与 herdr 官方集成同一套：`HERDR_ENV=1` + `HERDR_PANE_ID` + `HERDR_SOCKET_PATH`。
 * 不查 `HERDR_BIN_PATH`：我们走 socket，不需要那个二进制。
 */
export function herdrPane(env: NodeJS.ProcessEnv = process.env): HerdrPane | undefined {
  if (env.HERDR_ENV !== '1') return undefined;
  const paneId = env.HERDR_PANE_ID;
  const socketPath = env.HERDR_SOCKET_PATH;
  if (!paneId || !socketPath) return undefined;
  return { paneId, socketPath };
}

/**
 * socket 的**平台形式**。
 *
 * Windows 上 `HERDR_SOCKET_PATH` 是个**路径形状的命名管道名**（`…\AppData\Roaming\herdr\herdr.sock`）：
 * 直接 connect 那个路径会 `ENOTSOCK`（实测），必须先加 `\\.\pipe\` 前缀；Unix 上它就是
 * unix socket 的路径，原样用。herdr 自己的集成脚本也是这么做分支的。
 */
export function herdrSocketEndpoint(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** 一条请求的结局：herdr 回了 `result`（`ok`）还是别的（连不上/超时/它回的 error）。 */
export type HerdrReply = { ok: true } | { ok: false; reason: string };

/** 发一条请求（一行 JSON）等回执。任何失败都只是 `{ ok: false }` —— 见文件头的「失败面」。 */
export function sendHerdrRequest(
  endpoint: string,
  request: unknown,
  timeoutMs = 500,
): Promise<HerdrReply> {
  return new Promise<HerdrReply>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = createConnection(endpoint);
    const finish = (reply: HerdrReply): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // destroy（而不是 end）：这是一次性的请求-回执，不需要优雅关闭，而 end 会等对端。
      socket.destroy();
      resolve(reply);
    };
    // 只有定时器 unref：连接本身**不** unref —— 退出路径上那条 release 还指望它把字节
    // 写出去（那种「已经连上、write 同步完成」的情况真能到）。定时器不 unref 的话，
    // 进程会被一个连不上的 socket 多挂 500ms，那也是白等。
    timer = setTimeout(() => finish({ ok: false, reason: `herdr 没在 ${timeoutMs}ms 内回执` }), timeoutMs);
    timer.unref?.();
    socket.on('error', (error: Error) => finish({ ok: false, reason: error.message }));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (data: Buffer) => finish(parseReply(data)));
    socket.on('end', () => finish({ ok: false, reason: 'herdr 关掉了连接且没有回执' }));
  });
}

/** herdr 的回执是一行 JSON：带 `error` 就是它拒了（`message` 是原因），否则算收下。 */
function parseReply(data: Buffer): HerdrReply {
  const line = data.toString().split('\n')[0]?.trim() ?? '';
  if (line === '') return { ok: false, reason: 'herdr 的回执是空的' };
  try {
    const parsed = JSON.parse(line) as { error?: { message?: unknown } | undefined };
    const message = parsed.error?.message;
    return typeof message === 'string' ? { ok: false, reason: message } : { ok: true };
  } catch {
    return { ok: false, reason: `herdr 的回执不是 JSON：${line}` };
  }
}

/** 会话引用：给 herdr 的「服务器重启后回哪儿」（见文件头）。 */
export interface HerdrSessionRef {
  /** 会话文件（`sessions/<cwd>/<时间戳>_<id>.jsonl`）。 */
  path?: string | undefined;
  /** 会话 id。 */
  id?: string | undefined;
  /** herdr 重启后用它把会话拉回来：第一项必须是 PATH 上的**命令名**（herdr 会校验）。 */
  resumeArgv?: readonly string[] | undefined;
}

/** 一次要报的东西。 */
export interface HerdrReport {
  state: HerdrAgentState;
  message?: string | undefined;
  session?: HerdrSessionRef | undefined;
}

/**
 * store 的一帧 → 该给 herdr 报什么（纯函数，好测）。
 *
 * 三档的判据：
 * - `executing` 里有 `ask_user_question` → `blocked`（模型在等用户答题，见那个常量的注释）；
 * - 其余看 `phase`：`idle` → `idle`（等你说话）；`thinking` / `calling-tools` → `working`。
 *
 * 问卷的判据**先于** phase：问卷挂起时 phase 是 `calling-tools`，只看 phase 会把它报成
 * `working` —— 而 sidebar 上「在跑」与「等你」是两件完全不同的事（后者要弹通知）。
 */
export function herdrReportFor(state: AgentState, session?: HerdrSessionRef | undefined): HerdrReport {
  const waiting = state.executing.some((tool) => tool.call.name === ASK_USER_QUESTION);
  const report: HerdrReport = waiting
    ? { state: 'blocked', message: BLOCKED_MESSAGE }
    : { state: state.phase === 'idle' ? 'idle' : 'working' };
  return session === undefined ? report : { ...report, session };
}

/**
 * 请求参数（**不含 `seq`**）。
 *
 * 拆出来是为了去重：内容一样但 seq 不同，那不算「变了」—— herdr 那边每条请求都会
 * 推一次 revision、惊动界面，而 ela 的 store 每来一个 token 都要动一次。
 */
function reportParams(paneId: string, source: string, agent: string, report: HerdrReport): Record<string, unknown> {
  const params: Record<string, unknown> = {
    pane_id: paneId,
    source,
    agent,
    state: report.state,
  };
  if (report.message !== undefined) params.message = report.message;
  const session = report.session;
  if (session?.path !== undefined) params.agent_session_path = session.path;
  if (session?.id !== undefined) params.agent_session_id = session.id;
  if (session?.resumeArgv !== undefined) params.resume_argv = [...session.resumeArgv];
  return params;
}

export interface HerdrReporter {
  /**
   * 报一次。**内容与上次相同就一条都不发**（去重键见 `reportParams`），所以调用方可以
   * 挂在 store 的每次变化上，不必自己算「什么才算变了」。
   */
  report(next: HerdrReport): void;
  /** 放开这个 pane（退出路径上用）。 */
  release(): void;
  /** 停止上报：之后的 `report()` 全是空转。在途的请求让它自己跑完。 */
  dispose(): void;
}

export interface HerdrReporterOptions {
  pane: HerdrPane;
  agent: string;
  source?: string;
  /** 传输层（测试注入）。 */
  send?: typeof sendHerdrRequest;
  /** 第一次失败时叫一次（之后静默 —— 见文件头的「失败面」）。 */
  onError?: ((reason: string) => void) | undefined;
}

/**
 * 造一个上报器。
 *
 * ## 为什么是「单条在途 + 只留最后一份」
 *
 * 这是 herdr 给集成作者的要求（“Send only the latest state. If several changes queue up
 * while a report is in flight, drop the older ones.”）：状态是**当前值**而不是事件流，
 * 排队把历史一条条发过去，herdr 上的状态会晚好几拍才追上。所以新请求直接顶掉还没发出去
 * 的那份，而在途那条发完再看队列里有没有最新的一份。
 *
 * ## 为什么 seq 从 `Date.now() * 1000` 起
 *
 * herdr 只接受**比上次大**的 seq，而「上次」是它记住的上一个 ela 进程（同一 pane、
 * 同一 source）。从时间戳起步就不可能与上一个进程撞车（与 herdr 官方 pi 扩展同一做法）。
 */
export function createHerdrReporter(options: HerdrReporterOptions): HerdrReporter {
  const source = options.source ?? HERDR_SOURCE;
  const endpoint = herdrSocketEndpoint(options.pane.socketPath);
  const send = options.send ?? sendHerdrRequest;
  let seq = Date.now() * 1000;
  let lastKey: string | undefined;
  let queued: Record<string, unknown> | undefined;
  let inFlight = false;
  let disposed = false;
  let complained = false;

  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  const fail = (reason: string): void => {
    if (complained) return;
    complained = true;
    options.onError?.(reason);
  };

  /**
   * 发一条。第一次 500ms 连不上就再等一次（1500ms）—— herdr 那边可能是**忙**（正在写
   * 快照），不是不在；官方 pi 扩展同样是「一次短超时 + 一次长超时」。
   */
  const deliver = async (request: Record<string, unknown>): Promise<void> => {
    const first = await send(endpoint, request, 500);
    if (first.ok) return;
    const second = await send(endpoint, request, 1500);
    if (!second.ok) fail(second.reason);
  };

  const drain = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      while (queued !== undefined) {
        const request = queued;
        queued = undefined;
        await deliver(request);
      }
    } finally {
      inFlight = false;
      if (queued !== undefined && !disposed) void drain();
    }
  };

  return {
    report(next: HerdrReport): void {
      if (disposed) return;
      const params = reportParams(options.pane.paneId, source, options.agent, next);
      const key = JSON.stringify(params);
      if (key === lastKey) return;
      lastKey = key;
      const at = nextSeq();
      queued = { id: `${source}:report:${at}`, method: 'pane.report_agent', params: { ...params, seq: at } };
      void drain();
    },

    release(): void {
      if (disposed) return;
      const at = nextSeq();
      queued = {
        id: `${source}:release:${at}`,
        method: 'pane.release_agent',
        params: { pane_id: options.pane.paneId, source, agent: options.agent, seq: at },
      };
      void drain();
    },

    dispose(): void {
      disposed = true;
      lastKey = undefined;
    },
  };
}

export interface StartHerdrReportingOptions {
  store: AgentStore;
  /** 取当前会话引用。**每次上报现取**：`/new` 会同时换 id 与文件。 */
  session?: (() => HerdrSessionRef | undefined) | undefined;
  /** 环境变量（测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 传输层（测试注入）。 */
  send?: typeof sendHerdrRequest;
  /** 第一次上报失败时叫一次。 */
  onError?: ((reason: string) => void) | undefined;
}

/**
 * 订阅 store，把状态变化按需推给 herdr；返回**拆台函数**（拆订阅 + release）。
 *
 * 不在 herdr 里、或 `ELA_HERDR_AGENT` 关掉时返回一个空壳 —— 零开销、零副作用，
 * 与本项目在别处「不在那个环境里就什么都不做」的口径一致。
 *
 * 调用方：`packages/tui/src/main.ts`（**只有交互式**那一条路 —— 一次性模式没有 PTY
 * 给 herdr 显示，与 herdr 官方集成 `ctx.mode === 'tui'` 的门同一个理由）。
 */
export function startHerdrReporting(options: StartHerdrReportingOptions): () => void {
  const pane = herdrPane(options.env);
  const agent = herdrAgentName(options.env);
  if (pane === undefined || agent === undefined) return () => {};

  const reporter = createHerdrReporter({
    pane,
    agent,
    ...(options.send !== undefined ? { send: options.send } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  const push = (): void => {
    reporter.report(herdrReportFor(options.store.getState(), options.session?.()));
  };
  const unsubscribe = options.store.subscribe(push);
  // 订阅那一刻可能已经有状态（恢复会话时 store 里早就有东西了），先补一次 ——
  // 与 session-recorder 的 `flush()` 同一个理由。
  push();

  return () => {
    unsubscribe();
    // release **先于** dispose：dispose 之后 release 会被当成空转（见 `HerdrReporter.release`）。
    reporter.release();
    reporter.dispose();
  };
}
