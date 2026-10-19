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
 * 上报。herdr 也给 pi 装了一份官方集成（`herdr:pi`，写在 pi 的扩展目录里），而 ela
 * 的扩展宿主扫的正是那个目录 —— 它在本项目里也会跑（ela 同样会发 `session_start`），
 * 跟这里抢同一个 pane。下一节「为什么要挡掉…」讲的就是这件事。
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
 * ## resume 要**两步**：先持有 pane，再附命令
 *
 * herdr 对 `resume_argv` 有一条额外规矩（*Socket API → Agent state reporting*）：
 *
 * > A custom agent must hold the pane through `pane.report_agent` before it can attach
 * > a command; otherwise the request fails with `resume_not_accepted`.
 *
 * 也就是说「第一次上报就带 resume」只有在那个 pane **还没有主**的时候才恰好能过；
 * 一旦 pane 已经被别的上报者占着，herdr 会**整条拒掉**（连状态一起不生效）并回
 * `resume_argv requires the reporter to hold the pane; report its state with pane.report_agent first`。
 * 所以这里分两步：第一次只报状态（顺带把 pane 拿下来），收下之后再把 resume 补一条。
 * 补的那条被拒（`resume_not_accepted`）就**安静地**降级成只报状态 —— pane 里已经有
 * 别人在报 resume 了，那不是错误（见下一节）。
 *
 * ## 为什么要挡掉 herdr 自己那份 pi 扩展
 *
 * herdr 的官方 pi 集成（`~/.pi/agent/extensions/herdr-agent-state.ts`，source
 * `herdr:pi`）是**装在 pi 扩展目录**里的，而 ela 的扩展宿主扫的就是那个目录 —— 于是
 * 它在 ela 里也会跑，也往同一个 pane 报（`session_start` 那一刻就报，比这里的
 * `startHerdrReporting` 还早）。
 *
 * 实证（herdr 0.9.3）：官方的 `herdr:` source 一旦持有 pane，**自定义 source 就再也
 * 拿不到它** —— 状态上报回 `ok`，但 `pane.get` 里的 agent 与 session 仍旧是
 * `herdr:pi`，`resume_argv` 永远 `resume_not_accepted`。后果是服务器重启后 herdr 用
 * 它内置的 `pi --session <id>` 把 pane 拉起来（一个没有 ela 状态的 pi），而不是
 * `ela --session <id>` —— 这正是 ela 要自己上报的原因。
 *
 * 所以 ela 自己报的时候，`extension-host.ts` 会把那份**herdr 托管的** pi 扩展跳过
 * （按文件头的 `HERDR_INTEGRATION_ID=pi` 标记认，只跳这一个）。`ELA_HERDR_AGENT=off`
 * 时这里不上报，那份扩展就照常装（mac / linux 上仍由 herdr 官方集成管这个 pane）。
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
 *
 * ## 两步上报的状态机
 *
 * `holdsPane` 是唯一一个「herdr 那边的状态」：第一条 report 被收下之后才为真。
 * 在那之前 resume_argv 一律不带（带了可能整条被拒）；变真之后补发最新一份带 resume 的。
 * `resumeUsable` 是被拒之后的降级开关：`resume_not_accepted` 说明 pane 归别人，
 * 安静地不再尝试（状态照报）；`invalid_resume_argv` 说明我们自己的命令形状错了，
 * 报一次错（免得一直带着一个永远被拒的字段）然后再降级。
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
