/**
 * herdr 集成 —— 让 herdr 的 sidebar / `agent list` 认出这个 pane 里跑的是 pi。
 *
 * 必须**自己上报**：herdr 靠前台进程身份认 agent，而 ela 的进程是 `node …/bin/ela.mjs`；
 * 提示变量 `HERDR_AGENT` 只在 Linux / macOS 生效（Windows 那份二进制根本不读它）。
 *
 * 报什么：`HERDR_SOCKET_PATH` 上的 socket（一行一个 JSON），方法 `pane.report_agent` /
 * `pane.release_agent`，agent 名 `pi`（可被 `ELA_HERDR_AGENT` 覆盖），source `ela`。
 * 会话引用报本项目自己那份，resume 命令是 `ela --session <id>` —— herdr 服务器重启后
 * 拉起来的是 ela 自己，而不是一个没有 ela 状态的 pi 进程。
 *
 * 不走 `HERDR_BIN_PATH` 那套 CLI：每次状态变化起一个几十 MB 的进程（状态是每轮好几次），
 * 而 socket 正是 herdr 自己的 pi 扩展走的那条路。
 *
 * resume 要**两步**：herdr 要求 reporter 先持有 pane 才能附命令，否则整条被拒
 * （`resume_not_accepted`）。所以第一次只报状态，收下之后再补一条带 resume 的；补的那条
 * 被拒就安静地降级成只报状态。
 *
 * 要挡掉 herdr 自带的 pi 扩展（`herdr:pi`，装在 pi 扩展目录里，ela 的宿主也会扫到它）：
 * 官方的 source 一旦持有 pane，自定义 source 就再也拿不到它，`resume_argv` 永远被拒。
 * 所以 `extension-host.ts` 在 ela 自己上报时跳过那一份（按 `HERDR_INTEGRATION_ID` 标记认）。
 *
 * 报不上不算错：变量不全 / 连不上 / herdr 回错误一律吞掉，第一次失败通过 `onError` 说一声。
 *
 * 退出不靠 release 兜底：Ctrl+D / Ctrl+C 走 `process.exit()`，异步 socket 写不出去；
 * herdr 自己会发现上报进程没了并清掉 pane，所以 `dispose()` 只管停订阅。
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
 * ela 是不是要**自己**上报这个 pane（在 herdr 里、且没被 `ELA_HERDR_AGENT` 关掉）。
 *
 * 单独暴露出来是给扩展宿主用的：自己上报时要把 herdr 托管的 pi 扩展**跳过**，
 * 否则它会把 pane 的 authority 抢走、ela 的 resume 永远附不上（见文件头
 * 「为什么要挡掉 herdr 自己那份 pi 扩展」）。
 */
export function herdrSelfReportingActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return herdrPane(env) !== undefined && herdrAgentName(env) !== undefined;
}

/**
 * socket 的**平台形式**：Windows 上 `HERDR_SOCKET_PATH` 是路径形状的命名管道名，
 * 必须先加 `\\.\pipe\` 前缀（直接 connect 会 `ENOTSOCK`）；Unix 上原样用。
 */
export function herdrSocketEndpoint(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** 一条请求的结局：herdr 回了 `result`（`ok`）还是别的（连不上/超时/它回的 error）。 */
export type HerdrReply =
  | { ok: true }
  /** `code` 是 herdr 自己的错误码（`resume_not_accepted` 之类）；连不上/超时没有。 */
  | { ok: false; reason: string; code?: string | undefined };

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
    const parsed = JSON.parse(line) as {
      error?: { code?: unknown; message?: unknown } | undefined;
    };
    const message = parsed.error?.message;
    if (typeof message !== 'string') return { ok: true };
    const code = parsed.error?.code;
    return typeof code === 'string' ? { ok: false, reason: message, code } : { ok: false, reason: message };
  } catch {
    return { ok: false, reason: `herdr 的回执不是 JSON：${line}` };
  }
}

/** pane 被别的上报者占着时 herdr 对 `resume_argv` 的回执（见文件头「resume 要两步」）。 */
const RESUME_NOT_ACCEPTED = 'resume_not_accepted';

/** `resume_argv` 本身不合 herdr 的形状（命令名是路径、带撇号/控制字符……）。 */
const INVALID_RESUME_ARGV = 'invalid_resume_argv';

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
 * store 的一帧 → 该给 herdr 报什么（纯函数）。
 *
 * - `executing` 里有 `ask_user_question` → `blocked`（模型在等用户答题）；
 * - 其余看 `phase`：`idle` → `idle`，`thinking` / `calling-tools` → `working`。
 *
 * 问卷判据必须**先于** phase：问卷挂起时 phase 是 `calling-tools`，只看 phase 会报成
 * `working` —— 而 sidebar 上「在跑」与「等你」是两件不同的事（后者要弹通知）。
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
function reportParams(
  paneId: string,
  source: string,
  agent: string,
  report: HerdrReport,
  /** 只有已经持有 pane 才带 `resume_argv`（herdr 的规矩，见文件头）。 */
  withResume: boolean,
): Record<string, unknown> {
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
  if (withResume && session?.resumeArgv !== undefined) params.resume_argv = [...session.resumeArgv];
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
 * 「单条在途 + 只留最后一份」是 herdr 的要求：状态是**当前值**而不是事件流，排队把历史
 * 一条条发过去，herdr 上的状态会晚好几拍才追上。所以新请求顶掉还没发出去的那份。
 *
 * seq 从 `Date.now() * 1000` 起：herdr 只接受比上次大的 seq，而「上次」是它记住的**上一个
 * ela 进程**（同一 pane、同一 source），从时间戳起步才不会与它撞车。
 *
 * 两步上报的状态机：`holdsPane` 是唯一一个「herdr 那边的状态」，第一条 report 被收下之后
 * 才为真 —— 在那之前 resume_argv 一律不带，变真之后补发最新一份带 resume 的。
 * `resumeUsable` 是被拒之后的降级开关：`resume_not_accepted` 说明 pane 归别人，安静地不再
 * 尝试（状态照报）；`invalid_resume_argv` 说明我们自己的命令形状错了，报一次错再降级。
 */
export function createHerdrReporter(options: HerdrReporterOptions): HerdrReporter {
  const source = options.source ?? HERDR_SOURCE;
  const endpoint = herdrSocketEndpoint(options.pane.socketPath);
  const send = options.send ?? sendHerdrRequest;
  let seq = Date.now() * 1000;
  let lastKey: string | undefined;
  /** 最后一次**被 herdr 收下**的去重键（与 `lastKey` 不同：它可能是一次被拒的尝试）。 */
  let lastAcceptedKey: string | undefined;
  /** 队列里只有一份：新请求顶掉旧的（见上面「单条在途」）。 */
  let queued: QueuedHerdrRequest | undefined;
  let inFlight = false;
  let disposed = false;
  let complained = false;
  /** herdr 是否已收下过本 source 的状态上报 —— `resume_argv` 的前提（见文件头）。 */
  let holdsPane = false;
  /** resume 被 herdr 拒过就只报状态：它要么归别的上报者，要么我们给错了形状。 */
  let resumeUsable = true;
  /** 最新一份报告：持有 pane 之后补发 resume 时用它（不能拿旧的那份）。 */
  let latest: HerdrReport | undefined;

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
   * 把**最新**一份报告排进队列（内容与上次一样就什么都不做）。
   *
   * 为什么单独抽出来：首次上报收下之后要拿 `latest` 再发一条带 resume 的，而那时
   * 排队里的那份可能已经被更新的状态顶掉了。
   */
  const pushLatest = (): void => {
    if (disposed || latest === undefined) return;
    const params = reportParams(
      options.pane.paneId,
      source,
      options.agent,
      latest,
      holdsPane && resumeUsable,
    );
    const key = JSON.stringify(params);
    if (key === lastKey) return;
    lastKey = key;
    const at = nextSeq();
    queued = {
      kind: 'report',
      key,
      request: { id: `${source}:report:${at}`, method: 'pane.report_agent', params: { ...params, seq: at } },
    };
    void drain();
  };

  /** resume 那条被拒：退回不带 resume 的版本重发一次（只要那份还没被收下过）。 */
  const downshiftResume = (): void => {
    resumeUsable = false;
    // 拿「最后被收下的那份」当去重基准：状态本身通常已经在第一次上报里送过了，
    // 那就不该因为一次被拒的 resume 而重发一条一模一样的（herdr 会白推一次 revision）。
    lastKey = lastAcceptedKey;
    pushLatest();
  };

  /**
   * 发一条。第一次 500ms 连不上就再等一次（1500ms）—— herdr 那边可能是**忙**（正在写
   * 快照），不是不在；官方 pi 扩展同样是「一次短超时 + 一次长超时」。
   */
  const deliver = async (request: Record<string, unknown>): Promise<HerdrReply> => {
    const first = await send(endpoint, request, 500);
    if (first.ok) return first;
    // herdr **回了话**（带错误码）就是它的判决，再发一次不会变 —— 比如
    // `resume_not_accepted`，重试只会把降级拖晚 500ms。只有连不上/超时（没有码）才值得再等一次。
    if (first.code !== undefined) return first;
    return send(endpoint, request, 1500);
  };

  const drain = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      while (queued !== undefined) {
        const item = queued;
        queued = undefined;
        const reply = await deliver(item.request);
        if (item.kind === 'release') {
          if (reply.ok) holdsPane = false;
          else fail(reply.reason);
          continue;
        }
        if (reply.ok) {
          lastAcceptedKey = item.key;
          if (!holdsPane) {
            holdsPane = true;
            // 现在才允许附 resume（herdr 的「先持有 pane」）；最新那份马上补发。
            pushLatest();
          }
          continue;
        }
        if (!resumeUsable) {
          // 已经降级过了，这条只可能是普通的状态上报失败。
          fail(reply.reason);
          continue;
        }
        if (reply.code === RESUME_NOT_ACCEPTED) {
          // 另一个上报者（herdr 自己的 pi 扩展）占着 pane：状态照报，resume 归它。
          // 这不是「上报失败」，不该惊动用户（见文件头「为什么要挡掉…」）。
          downshiftResume();
          continue;
        }
        if (reply.code === INVALID_RESUME_ARGV) {
          // 这条是我们自己的 bug：命令名不是 PATH 上的名字 / 带撇号…… 说一声再降级。
          fail(reply.reason);
          downshiftResume();
          continue;
        }
        fail(reply.reason);
      }
    } finally {
      inFlight = false;
      if (queued !== undefined && !disposed) void drain();
    }
  };

  return {
    report(next: HerdrReport): void {
      if (disposed) return;
      latest = next;
      pushLatest();
    },

    release(): void {
      if (disposed) return;
      const at = nextSeq();
      queued = {
        kind: 'release',
        request: {
          id: `${source}:release:${at}`,
          method: 'pane.release_agent',
          params: { pane_id: options.pane.paneId, source, agent: options.agent, seq: at },
        },
      };
      void drain();
    },

    dispose(): void {
      disposed = true;
      lastKey = undefined;
      latest = undefined;
    },
  };
}

/** 队列里的一份：`kind` 决定回执怎么处理（report 失败会触发 resume 降级，release 不会）。 */
interface QueuedHerdrRequest {
  kind: 'report' | 'release';
  /** report 的去重键：被收下时记下来，留着 resume 降级后判断要不要重发。 */
  key?: string | undefined;
  request: Record<string, unknown>;
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
 * 不在 herdr 里、或 `ELA_HERDR_AGENT` 关掉时返回一个空壳 —— 零开销、零副作用。
 *
 * 调用方只有 `tui/src/main.ts` 的**交互式**那条路：一次性模式没有 PTY 给 herdr 显示。
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
