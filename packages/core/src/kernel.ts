/**
 * 内核 —— 整个应用**唯一**跑环的地方。
 *
 * 只有一个权威 Loop。界面层（`packages/tui/src/`）只是它的渲染层：订阅 store、画状态、把输入 dispatch 回去。
 * 这不是洁癖，是必需的 —— 如果另有一处跑环，就会出现「两处都发起 LLM 调用」「两处的消息流不一致」，
 * 而环本身是有副作用的（真的调模型、真的改文件）。
 *
 * 装配一次，得到：
 *   - store       Redux Loop 的状态树（环的收敛点）
 *   - persistence 轨迹落盘器（错误也落盘）
 *
 * 界面层只做两件事：把用户输入 dispatch 进去，以及订阅 store 把状态画出来。
 */
import {
  createFauxRuntime,
  createRuntime,
  demoResponses,
  type AgentRuntime,
} from './provider';
import { createPersistentStore } from './store';
import { createFileSink, loadTrace, tracePath, type TraceDir } from './trace-file';
import { newSessionId } from './trace';
import type { AgentStore } from './store';
import type { InitRecord, TracePersistence, TraceSink } from './trace-store';
import type { Message, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentAction, ModelCapabilities } from './actions';
import type { ExtensionLifecycleEvent } from './extension-events';
import { createSessionRecorder, type SessionRecorder } from './session-recorder';
import { readSession, readSessionThinking, sessionMessages, sessionThinking } from './session-file';
import { findSessionFile } from './config-home';
import {
  clampForModel,
  isThinkingLevel,
  readDefaultThinkingLevel,
  readModelThinkingLevel,
  readThinkingBudgets,
  resolveStartupThinkingLevel,
  thinkingLevelForModelSwitch,
} from './thinking-level';
import { readCompactionEnabled, writeCompactionEnabled } from './compact';
import path from 'node:path';
import { declaredToolset } from './tools';
import { buildPromptParts, buildSystemPromptText, promptToolsFrom, type PromptToolLike } from './system-prompt';
import { loadExtensionHost } from './extension-host';
import type { HostUiOptions } from './extension-ui';
import type { ExtensionHost } from './extension-host';
import { loadSkillRegistry } from './skills';
import { loadPromptRegistry } from './prompts';
/**
 * 从 Model 对象上读我们关心的三个能力。
 *
 * 位置不一样，所以分开取：
 *   - `supportsMidConvoSystemMessages` / `supportsMidConvoToolAdditions` 在 **BaseModel** 上（顶层）；
 *   - `supportsDeveloperRole` 在 **compat** 里，而且只有 openai 一族的 compat 有这个字段。
 *
 * 读不到就当 false（保守）—— 「以为支持但实际不支持」会让 pi-ai 把消息发出去然后被
 * provider 拒，而那种失败长得像「随机 400」。
 *
 * 导出是因为 `setModel()` 与它的测试都要用**同一个读法**：两处各写一份的话它们会漂移，
 * 而漂移的症状是「底栏换了、实际请求还是按旧能力发」（那类失败极难归因）。
 */
export function readCapabilities(model: Model<any>): ModelCapabilities {
  // 这两个标志声明在 BaseModel 上，但 pi-ai 的 Model 类型没把它们带进公开面，
  // 所以这里按「运行时确实有这个字段」来读（模型目录里带就是 true）。
  const raw = model as Model<any> & {
    supportsMidConvoSystemMessages?: boolean;
    supportsMidConvoToolAdditions?: boolean;
  };
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return {
    midConvoSystemMessages: raw.supportsMidConvoSystemMessages === true,
    midConvoToolAdditions: raw.supportsMidConvoToolAdditions === true,
    developerRole: compat?.supportsDeveloperRole === true,
  };
}
export interface KernelOptions {
  provider: string;
  model?: string | undefined;
  /**
   * 用户自定义的**前置**提示（`--system`）。
   *
   * **可选** —— 不给就用 pi 的 `buildSystemPrompt` 拼一整份（工具规则 / AGENTS.md /
   * cwd / skill 清单，见 [system-prompt.ts](system-prompt.ts)）。早先这里是**必填**且
   * 外面手写三行中文，那样模型完全不知道 `edit` 的 `oldText` 要精确匹配、
   * 也不知道这个项目的 `AGENTS.md` 写了什么 —— 而那些正是踩坑换来的经验。
   *
   * 给了它就顶掉 pi 的 preamble（官方 `customPrompt` 的语义），其余各段照旧拼上。
   */
  systemPrompt?: string | undefined;
  /**
   * 追加到 prompt 末尾的规则（进 `<addendum>` 段）。
   *
   * **优先级低于文件**：`.pi/APPEND_SYSTEM.md`（或家目录那份）存在时用它，那个优先 ——
   * 项目里的规则比命令行临时加的更“近”。
   */
  appendSystemPrompt?: string | undefined;
  /** 工作目录：官方工具用它做路径边界检查（防止模型跑出这个目录）。 */
  cwd: string;
  /** 不打网络，用 pi-ai 的 faux provider。 */
  demo?: boolean | undefined;
  /**
   * 命令行请求的思考级别（`--thinking` / `-m id:high` 的那种）。
   *
   * **不给就按 pi 的顺序解析**（`core/sdk.js:120-142`）：会话文件里那条 → settings 的
   * per-model 覆盖 → settings 的全局默认 → 内置 `medium`，最后 clamp 到当前模型支持的
   * 那几档。命令行给了就最高优先（但仍然 clamp）—— 与 pi 的 `--thinking` 同一句
   * 「clamps thinking to the model's capabilities」。
   *
   * 解析规则全在 `thinking-level.ts`（那里是唯一入口，所以启动那一档与 `/thinking`
   * 面板上打勾的那一档一定是同一个）。
   */
  thinkingLevel?: ModelThinkingLevel | undefined;
  llmTimeoutMs?: number | undefined;
  maxLlmAttempts?: number | undefined;
  maxTurns?: number | undefined;
  sessionId?: string | undefined;
  /** 传 null 就完全不落盘。 */
  traceDir?: TraceDir | null | undefined;
  onTraceError?: ((error: unknown) => void) | undefined;
  /** false = 不写会话文件（只落轨迹）。 */
  writeSession?: boolean | undefined;
  /** 恢复已有会话时传「已经灌进去多少条消息」，记录器的游标要接着算，否则会重写一遍。 */
  resumeFrom?: number | undefined;
  /**
   * 额外的 skill 路径（文件或目录），对应 pi 的 `--skill`。
   *
   * 与默认目录（`~/.pi/agent/skills` 与 `<cwd>/.pi/skills`）**叠加**，不是替换。
   */
  skillPaths?: readonly string[] | undefined;
  /**
   * 造扩展 `ctx.ui` 的工厂（界面层给，内核只负责传下去）。
   *
   * 不给 = 没有界面（一次性模式、测试）—— 扩展仍会装上（`settings.json` 的 `packages`
   * 与界面无关），但真去开对话框时会得到一句说人话的错。
   */
  uiOptions?: (() => HostUiOptions) | undefined;
  /**
   * **不等扩展装载**：`createKernel()` 在 store 与 `model.init` 就绪之后就返回，
   * 扩展装载（jiti，实测 2~3s）与它后面的 prompt 装配在**后台**跑，
   * `kernel.ready` 表示「装完了」。
   *
   * ## 为什么需要它
   *
   * 交互式界面的**首帧**要等 `createKernel()` 返回。而那 2~3s 全在扩展装载上 ——
   * 用户在启动时看到的就是「敲了命令，2~3 秒内什么都没发生」。打开这一档，界面
   * 立刻画出来（底栏、输入框、开场先报到手的那部分），扩展在后台接着装。
   *
   * ## 用它的地方必须做什么
   *
   * 1. **`ready` 之前不许发消息**：`state.prompt.tools` 与 system prompt 那一刻还是
   *    「没有扩展」的形状，先发出去的那条消息会把一份缺工具集的 head 写进会话与轨迹
   *    （而 head 是不可改的历史，见 `prompt-head.ts`）。界面那边把发送挂在 `ready` 上
   *    （`tui/app.ts` 的 `send()`），一次性模式**不打开这一档**（没有首帧可提前）。
   * 2. **读 `kernel.extensions.*` 要能在就绪后才读**：它是活视图（见 `Kernel.extensions`），
   *    界面不能把「现在读到的内容」当成终局 —— 开场横幅要在 `ready` 之后重报一次。
   *
   * ## 失败怎么表现
   *
   * 这一档下装载失败**不抛**（界面已经在跑了，抛没人接）：收进 `kernel.extensions.errors`
   * 由界面报出来。默认（不打开）那条路上失败照旧往外抛 —— 一次性模式该响亮地失败。
   */
  deferExtensions?: boolean | undefined;
  /** 跳过扩展装载（测试用；也省掉 jiti 那一跳的开销）。 */
  noExtensions?: boolean | undefined;
}

export interface Kernel {
  store: AgentStore;
  runtime: AgentRuntime;
  /** 当前会话 id。**会变**（开新会话 / 恢复历史），所以是只读取值。 */
  readonly sessionId: string;
  persistence: TracePersistence | null;
  /** 当前会话记录器（写 `sessions/<cwd>/<时间戳>_<id>.jsonl`，供「恢复历史」用）。 */
  readonly session: SessionRecorder | null;
  /**
   * 扩展宿主（`deferExtensions` 时是**活视图**）。
   *
   * ## 为什么是「活视图」而不是「那一刻的那个对象」
   *
   * `deferExtensions` 下这个字段在 `ready` 之前指向一个**空宿主**（与 `--no-extensions`
   * 同形），就绪后指向真的那个。而界面在 `createKernel()` 返回时就把里面几个引用
   * 抓走了（`extensions.commands`、开场横幅那份 `entries`）—— 换对象等于它们永远看到
   * 空的那份，症状是「扩展的斜杠命令不见了」而没有任何报错。
   *
   * 所以这里转发**每次读**：`kernel.extensions.commands.list()` 在就绪后念的是扩展的
   * 命令。代价是「读到的内容会变」—— 界面据此在 `ready` 之后重新报一次开场（见
   * `deferExtensions` 的注释）。
   */
  readonly extensions: ExtensionHost;
  /**
   * 扩展装载完成（`deferExtensions` 时才有意义；否则一开始就是已完成的）。
   *
   * **不会 reject**：`deferExtensions` 下装载失败收进 `extensions.errors`，
   * 这一条照常完成 —— 界面不能卡在「正在装载」上。
   */
  readonly ready: Promise<void>;
  /** 开一个新会话：换 id（于是换文件）、清空对话。**不会**把新消息写进旧文件。 */
  newSession(): { id: string };
  /**
   * 自动压缩现在开着吗。`null` = 这个装配不支持压缩（没有 `runCompact`），
   * 那时 `/settings` 那一行**不显示** —— 一个什么都压不了的开关就是谎。
   */
  autoCompactEnabled(): boolean | null;
  /**
   * 开/关自动压缩：立即生效（不再自动压）并写 `settings.json` 的 `compaction.enabled`。
   *
   * 关的只是**自动**那条路 —— 手动 `/compact` 仍然能用（那才是「关掉自动压缩」的意思）。
   */
  setAutoCompactEnabled(enabled: boolean): void;
  /**
   * 恢复一个历史会话（读文件 + 灌回 state）。**零 token**，不重跑模型。
   * @returns 恢复的会话 id 与灌进去的消息条数。
   */
  restoreSession(file: string): Promise<{ id: string; restored: number }>;
  /** 把已经读出来的消息灌回 state。 */
  restore(messages: Message[]): void;
  /**
   * 换模型。**真换** —— 之后的每个回合都发给新的那个。
   *
   * ## 一条 action 就够：`model.changed` 带**整套**模型参数
   *
   * 能力（`capabilities`）与窗口（`contextWindow`）是**模型之间不一样**的：一个支持中途插
   * system 的网关换成一个不支持的，还按旧的来会发出一份 provider 拒收的请求 —— 而那种
   * 失败长得像「随机 400」，极难归因。所以 `model.changed` 与 `model.init` **载荷完全一致**
   * （`ModelSpec`），一步把能力 / 窗口装到位，**不需要**「先保守清零、再补一条」的中间态。
   *
   * 两条 action 只差语义：`model.changed` 是「**切**成了什么」（轨迹里应当看得见），
   * `model.init` 是「**装载**了什么」（开局那一次）。
   *
   * 思考级别**带着走**（从 state 读再传回去）：换模型不该顺手把 `high` 改成 `off`。
   *
   * 准确说：按 pi 的 `_getThinkingLevelForModelSwitch` **重新解析**一遍（作用域条目 /
   * per-model 覆盖 / 全局默认都排在「当前这一档」前面，最后 clamp 到新模型支持的那几档）——
   * 没配过 settings 时结果与「带着走」相同，配过时才分得出来（见实现里的注释）。
   *
   * @returns 换成功没有。找不到那个模型就返回 `false` 并**不 dispatch** ——
   *   状态原封不动，比 dispatch 一次半换更安全。
   */
  setModel(
    provider: string,
    modelId: string,
    options?: { thinkingLevel?: string | undefined },
  ): boolean;
  /**
   * 收掉内核：摘订阅器、flush 会话与轨迹、关扩展宿主（含 MCP 的 stdio 子进程）。
   *
   * **可等待**：扩展宿主那一半要等 `session_shutdown` 关掉子进程，而子进程会握着
   * 事件循环 —— 不等它们，一次性模式的进程退不出去（见 `extension-host.ts` 的
   * `dispose()` 与 `main.ts` 的退出路径）。调用方不 await 也照旧工作（异步收尾照跑）。
   *
   * 幂等：重复调用只生效一次。
   */
  dispose(): Promise<void>;
}

/**
 * 默认 system prompt 是什么。
 *
 * **它不再是手写的字符串** —— 由 pi 的 `buildSystemPrompt` 拼（工具怎么用、`edit` 的坑、
 * `AGENTS.md` 项目上下文、cwd、skill 清单），见 [system-prompt.ts](system-prompt.ts)。
 *
 * 这个函数保留是因为它在两个地方是**方便入口**：测试与脚本想看一眼「没传 `--system`
 * 时到底会给模型发什么」。
 */
export async function defaultSystemPrompt(cwd: string = process.cwd()): Promise<string> {
  const { skills } = await loadSkillRegistry({ cwd });
  return buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd), skills });
}

export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const runtime = options.demo
    ? (() => {
        const faux = createFauxRuntime();
        faux.setResponses(demoResponses());
        return faux.runtime;
      })()
    : await createRuntime({
        provider: options.provider,
        ...(options.model ? { model: options.model } : {}),
      });

  // ── 会话级资源（可以换） ──
  //
  // 「开新会话」要换 sessionId，而轨迹 sink / 装载段 sink / 会话记录器都是**绑在 id 上**
  // 的（文件名由 id 决定），所以要能整体替换。用一个 holder 持有当前的三个，
  // 并把一个**转发 sink** 交给 store —— store 建好之后不该再被重建（那会丢状态）。
  interface SessionResources {
    sessionId: string;
    /** 轨迹 + 装载段（两者同一个文件，见 writeInit）。 */
    sink: TraceSink | undefined;
    recorder: SessionRecorder | null;
  }

  // 转发 sink：所有写入都问「当前是哪个」，这样换会话不需要重建 store。
  const delegator: TraceSink = {
    append: (line) => {
      const target = current.sink;
      return target ? target.append(line) : undefined;
    },
  };

  // 转发 sink 的另一个用法：**知道「当前会话已开始」**。
  //
  // 它不能只看 `current.sink` —— createFileSink 是懒的（不建目录、不建文件，只在第一次
  // append 时才 mkdir + appendFile），所以「有没有 sink」与「盘上有没有文件」无关。
  // 真正的事实是「用户发出第一句话了没有」，那就是 `state.traceBegun`
  // （reducer 在补装载节点时置上，见 user.message）。
  const activeSink: TraceSink = {
    ...delegator,
    append: (line) => {
      // 空会话不落盘：只装了东西、一句话都没说的会话不该在 traces/ 里留文件。
      // 与 SessionWriter 那边同一个决定（docs/architecture/sessions.md「空会话不落盘」）。
      //
      // 判据用 `traceBegun` 而不是「有没有写过」：落盘器自己**就是**订阅器，
      // 它在建好时就会 flush 一次（那时树上没有节点，本来也不该写）。
      if (!store.getState().traceBegun) return undefined;
      return delegator.append(line);
    },
  };

  const openResources = (id: string, resumeFrom?: number): SessionResources => {
    const dir = options.traceDir;
    return {
      sessionId: id,
      sink: dir === null ? undefined : createFileSink(tracePath(id, dir ?? undefined)),
      recorder: null, // 由下面的 openRecorder 填（它要等 store 建好）
    };
  };

  let current: SessionResources = openResources(options.sessionId ?? newSessionId());
  const sessionId = current.sessionId;
  const cwd = path.resolve(options.cwd ?? process.cwd());

  //
  // ── 思考级别：与 pi 同一套解析顺序（`core/sdk.js:120-142`） ──
  //
  // 顺序要点：命令行 > 会话文件里那条 > per-model 覆盖 > 全局默认 > 内置 `medium`，
  // 最后 clamp 到当前模型支持的那几档。三条来源各有一个坑：
  //
  // 1. **只在命令行真的给了 sessionId 时才去扫会话目录**。不给时 sessionId 是刚生成的
  //    UUIDv7，盘上一定没有这个文件 —— 扫一遍是白扫，而扫目录是启动路径上唯一的
  //    文件系统操作。pi 那边也一样：它只知道 `--continue` / `--session` 指的那个会话。
  // 2. 「文件在那」不等于「这是一个已有的会话」：pi 的 `hasExistingSession` 是
  //    `messages.length > 0`（空壳文件不算），而「不算」的后果是它会走「新会话」分支
  //    （于是 per-model 覆盖**会**被看到）。差别只在那一个布尔值上，照抄。
  // 3. clamp 在这里做（这个函数知道 model，pi 的 `createAgentSession` 也在这里做）——
  //    早先这里没有 clamp，而 `medium` 在 deepseek-v4.1-flash 上不是合法档位，
  //    症状是「底箱写着 medium，请求里发的是模型不认的 reasoning 值」。
  const startupSession =
    options.sessionId === undefined
      ? undefined
      : readSessionThinking(findSessionFile(options.sessionId, cwd));
  const thinkingLevel = clampForModel(
    runtime.model,
    resolveStartupThinkingLevel({
      cliLevel: options.thinkingLevel,
      sessionLevel: startupSession?.hasMessages === true ? startupSession.level : undefined,
      perModelLevel: readModelThinkingLevel(runtime.model.provider, runtime.model.id, cwd),
      defaultLevel: readDefaultThinkingLevel(cwd),
    }),
  );
  //
  // 思考预算（`settings.json` 的 `thinkingBudgets`）：与 pi 同一步，**开局读一次**
  // （`core/sdk.js:275`），之后每个请求原样带上（`effects.ts`）。
  //
  const budgets = readThinkingBudgets(cwd);

  // 工具执行门的持有者：store 先建、extensionHost 后建，所以走一个先声明、后赋值的引用。
  let extensionHostRef: ExtensionHost | undefined;

  /**
   * 生命周期事件的**唯一出口**：先落成 action（于是进轨迹、可回放），再发给扩展。
   *
   * ## 为什么是「先 dispatch 再 emit」
   *
   * 轨迹树是 action 的产物（reducer 把 `extension.lifecycle` 记成一条注释节点），
   * 而前端扩展是**当场**就要收到事件的 —— 两件事不能各写一遍：写两遍必然漂
   * （某条事件记得发却忘了记，或者反过来）。所以只有这一个函数。
   *
   * ## 为什么 dispatch 排在 emit 前面
   *
   * `emitLifecycle` 会同步开始跑扩展的 handler，而 handler 有可能又去 `dispatch`
   * （`pi.sendMessage` 之类）。先把「这件事发生过」写进状态，再去通知别人，顺序才是
   * 「先事实后反应」；反过来的话，扩展在 handler 里读到的状态会缺一条自己刚触发的事件。
   *
   * ## 循环风险
   *
   * dispatch 会再触发 store 订阅器（相位级事件就是订阅器发的）。那一路看的是
   * `phase` 有没有变，没变就直接 return —— 所以嵌套一层就停了，不会自激。
   */
  function recordLifecycle(event: ExtensionLifecycleEvent): void {
    store.dispatch({ type: 'extension.lifecycle', event } as AgentAction);
    extensionHostRef?.emitLifecycle(event);
  }

  const { store, persistence, autoCompact } = createPersistentStore({
    runtime,
    // `tool_call` 门：MCP 靠它等「脚本/模型点名了但服务器还没连上」。
    // `extensionHost` 在下面才建，所以走一个**闭包读当时值**的函数。
    onToolCall: (toolCallId, name, input) =>
      extensionHostRef === undefined
        ? Promise.resolve({ input })
        : extensionHostRef.beforeToolCall(toolCallId, name, input),
    // 扩展生命周期事件（`agent_start` 之外的都从 effect 来）：统一走 recordLifecycle
    // —— 先记进轨迹，再发给扩展（宿主还没装上时事件照旧记，只是没人收）。
    onExtensionEvent: recordLifecycle,
    // **不给** systemPrompt：真的那份由下面的 prompt.init 装（那时才需要 cwd、
    // 工具、skill）。这里给一个占位只会活到第一条 prompt.init。
    cwd,
    sessionId,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.maxLlmAttempts !== undefined ? { maxLlmAttempts: options.maxLlmAttempts } : {}),
    // 思考预算与压缩开关都是**开局读一次**（与 pi 同一步，见各自的注释）。
    ...(budgets !== undefined ? { thinkingBudgets: budgets } : {}),
    autoCompactEnabled: readCompactionEnabled(cwd),
    ...(options.traceDir === null ? {} : { traceSink: activeSink }),
    ...(options.onTraceError ? { onTraceError: options.onTraceError } : {}),
  });

  // ── 相位级生命周期事件（`agent_start` / `agent_end` / `agent_settled`）──
  //
  // 为什么用订阅器而不是在 reducer 里：reducer 是纯函数，发事件不属于它；而「环刚停下来」
  // 这个时刻在 redux-loop 里没有对应的 action（与 `createAutoCompact` 同一个理由，
  // 见 store.ts 的头注释）。订阅器盯 `phase`，任何停止路径都不漏。
  //
  // 事件走 `recordLifecycle()`：先记进轨迹，再发给扩展。宿主还没装上
  // （`deferExtensions` 的首帧那几秒）时只是没人收，**记录照旧** —— 轨迹是历史，
  // 不该因为那一刻没有监听者就把一段真实发生过的事漏掉。
  //
  // `agent_start` 的判据是 idle → 非 idle；`agent_end` / `agent_settled` 是反过来那一下。
  // **两个一起发**：pi 的 `agent_end` 是「这一轮结束」（可能还会继续），`agent_settled` 是
  // 「真的静了」；相位回到 idle 就是两者同时成立的那一点。扩展自己按 `agentSettledSupported`
  // 决定认哪个（Orca 的状态扩展就只认后者），所以两个都发，不替它选。
  let agentWasRunning = false;
  const unsubscribeAgentLifecycle = store.subscribe(() => {
    const state = store.getState();
    const running = state.phase !== 'idle';
    if (running === agentWasRunning) return;
    agentWasRunning = running;
    if (running) {
      recordLifecycle({ type: 'agent_start' });
    } else {
      recordLifecycle({ type: 'agent_end', messages: state.messages });
      recordLifecycle({ type: 'agent_settled' });
    }
  });

  // ── 扩展宿主的**活视图**（`deferExtensions` 用）──
  //
  // 见 `Kernel.extensions` 的注释（为什么不能直接换对象）。
  //
  // 就绪前指向一个**空宿主**：与 `--no-extensions` 同形（工具表只有官方那几个、
  // 命令表空、`beforeToolCall` 原样放行），界面在这段时间读到的就是「没有扩展」——
  // 那是一个**少东西但一致**的状态，而不是 undefined（后者会让界面在 `entries` 上炸）。
  const placeholderHost = await loadExtensionHost({ store, cwd, disabled: true });
  const deferredErrors: string[] = [];
  /** 已经 `dispose()` 了 —— 后台装载完成时不能再往界面上递一个活着的宿主。 */
  let disposed = false;
  const currentHost = (): ExtensionHost => extensionHostRef ?? placeholderHost;
  const extensionView: ExtensionHost = {
    // 逐条转发**每次读**：就绪后界面早先抓到的那个对象里就是真的那份了。
    get tools() {
      return currentHost().tools;
    },
    get promptTools() {
      return currentHost().promptTools;
    },
    get commands() {
      return currentHost().commands;
    },
    // 诊断是**两份**：占位那份自己的（没有）+ 后台装载整体失败的那条。
    get errors() {
      return [...currentHost().errors, ...deferredErrors];
    },
    get entries() {
      return currentHost().entries;
    },
    get loaded() {
      return currentHost().loaded;
    },
    beforeAgentStart: (text?: string) => currentHost().beforeAgentStart(text),
    startSession: () => currentHost().startSession(),
    collectPromptSections: () => currentHost().collectPromptSections(),
    // 参数用 `Parameters<…>` 原样透传（包括第四个 `options`）：这里少转发一个参数
    // 就是一行静默的降级（权限类扩展会丢掉 signal，而症状离真因很远）。
    beforeToolCall: (...args: Parameters<ExtensionHost['beforeToolCall']>) =>
      currentHost().beforeToolCall(...args),
    // 同样逐次转发：后台装载完成后，早先抱着的「空宿主」视图里这个方法就指向真宿主了
    // （否则就绪前发出的那些事件永远发不到扩展上）。
    emitLifecycle: (event: Parameters<ExtensionHost['emitLifecycle']>[0]) =>
      currentHost().emitLifecycle(event),
    dispose: () => currentHost().dispose(),
  };

  // ── 装载：`model.init` 与 prompt 各走一条 action 打进状态树 ──
  //
  // 为什么走 action 而不是直接写进 createInitialState：
  // 「装载」和「跑一轮对话」是同一类事（都是状态迁移），走 action 才能被落盘、被回放。
  // 回放时读到 init 段就知道当时发给模型的是什么，不必重装配工具、不必再问 provider 能力。
  //
  // 放在 store 建好之后：它们本身就是 dispatch，得走真实的 store。
  //
  // ## 两块为什么拆开：model 不依赖扩展，prompt 依赖
  //
  // `deferExtensions`（交互式界面靠它把首帧提前 2~3 秒，见 `KernelOptions`）只把
  // **prompt 那一块**推到后台：底栏在首帧就要显示 `(provider) model`，而那份数据只
  // 来自 runtime 与启动解析出来的档位。把它留在后面的话，扩展装载的那几秒里底栏是
  // `() `（看着像坏了）。轨迹不受这个顺序影响：`beginTrace()` 只认
  // `state.prompt.seeded` / `state.model.seeded`，而它要等用户发出第一句话才跑。
  store.dispatch({
    type: 'model.init',
    provider: runtime.spec.provider,
    modelId: runtime.model.id,
    thinkingLevel,
    // 底栏据此决定显不显示 `• <级别>`（reasoning 模型才有思考级别这回事）。
    reasoning: runtime.model.reasoning ?? false,
    capabilities: readCapabilities(runtime.model),
    // 底箱的「已用 / 1.0M」要用。取不到就 0，底箱会不画那个百分比。
    contextWindow: runtime.model.contextWindow ?? 0,
  });

  // ── 会话记录器：**必须在扩展装载之前建** ──
  //
  // 顺序不是随手排的：扩展的 `ctx.sessionManager.getSessionFile()` 要报「这个会话的
  // 文件是哪个」，而它在 `session_start` 那一刻就被读走、之后不再刷新（那是 pi 的
  // 状态扩展自己的逻辑）。Orca 那类宿主靠这个路径把「对话记录在哪」认下来 ——
  // 拿不到就只能一直显示 loading。
  //
  // 报的是**计划路径**（`SessionWriter.path`），不是「文件已经在盘上」：本项目
  // 空会话不建文件（见 session-file.ts），而状态扩展读的时候自己会 `existsSync` 重试
  // （`getPersistedSessionMetadata`），第一条消息落盘之后那份元数据就真的带上去了 ——
  // 与 pi 自己的注释「Pi publishes its planned path before creating the transcript」
  // 同一回事。
  const openRecorder = (
    id: string,
    resumeFrom?: number,
    hasThinkingEntry?: boolean,
  ): SessionRecorder | null => {
    const rec = createSessionRecorder(store, {
      sessionId: id,
      cwd,
      enabled: options.writeSession !== false,
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      ...(hasThinkingEntry !== undefined ? { hasThinkingEntry } : {}),
    });
    current = { ...current, sessionId: id, recorder: rec };
    return rec;
  };
  // 恢复场景的两件事合并成一处：**已有会话**（有消息）才谈「它记没记过档位」——
  // 空壳文件不算已有会话，走新会话那条路（会补写一条初始记录）。
  openRecorder(
    sessionId,
    options.resumeFrom,
    startupSession?.hasMessages === true ? startupSession.hasEntry : undefined,
  );

  // ── 扩展 + prompt：启动路径上最重的一块（jiti 装扩展，实测 2~3s）──
  //
  // **扩展先装、工具清单后取** —— 顺序不能反。`getTools()` 是「官方工具 + 扩展工具」
  // 的合并结果，而 `prompt.init` 把那份清单装进 state（`effects.ts` 的 `toolSchemas()`
  // 原样读它发给模型）。先装扩展再取清单，模型才知道它有 `ask_user_question`；
  // 反过来它就只存在于注册表，症状是「工具调用永远回『未知工具』」，而界面上
  // 那个工具块连参数都画不出来。
  //
  // 包成一个函数而不是就地 await：`deferExtensions` 时它要在后台跑（见下面那个分岔）。
  const assembleExtensions = async (): Promise<void> => {
    const extensionHost = await loadExtensionHost({
      store,
      cwd,
      // 扩展要自己调模型时靠这个拿凭证（`pi-web-access` 的答案/摘要）。主路径下
      // `runtime.runtime` 就是 pi 的 ModelRuntime（44 个内置 provider + 1500 模型），
      // extension-models.ts 把它包成扩展认的 ModelRegistry。
      ...(options.noExtensions ? {} : { runtime }),
      ...(options.uiOptions ? { uiOptions: options.uiOptions } : {}),
      ...(options.noExtensions ? { disabled: true } : {}),
      // 会话：扩展的 `getSessionId()` / `getSessionFile()` / `getBranch()`。传的是
      // **取值函数**而不是常量 —— `/new` 换会话后 id 与文件都变，而扩展问的时候得报
      // 新的那个。`recorder` 此刻还是 null（`openRecorder` 在后面），但取值函数读的是
      // `current`，扩展真问的时候它已经填上了。
      sessionId: () => current.sessionId,
      sessionFile: () => current.recorder?.file,
      // 扩展的 `pi.sendMessage` 落到哪里：一条**用户消息**（于是环会跑起来），
      // 与界面里敲一句话同一条路。
      onSendMessage: (text) => {
        if (text.trim() === '') return;
        store.dispatch({ type: 'user.message', text } as AgentAction);
      },
      canSend: () => store.getState().phase === 'idle',
    });
    extensionHostRef = extensionHost;
    // 已经退出过了（`dispose()` 早于装载完成）：这个宿主没人管了，就地收掉 ——
    // 否则 MCP 的子进程会挂在事件循环上（症状是「Ctrl+C 之后进程不退」）。
    if (disposed) {
      await extensionHost.dispose();
      return;
    }
    // ── 发 `session_start`：MCP 靠它读 `mcp.json` 并开始连服务器 ──
    //
    // **必须在算工具表之前**：MCP 会发现「有 codemode 暴露的服务器」并激活 `codemode`
    // （走 `setActiveTools` → 本项目的 `state.prompt.tools`）；而 `direct` 服务器的工具是
    // 在连接过程中动态注册的 —— 加载后必须再扫一遍。
    await extensionHost.startSession();
    // 收 `before_agent_start` 写的 prompt 段（MCP 的 `mcp_servers`）。
    // 它里面还会等 `direct` 服务器最多 10 秒（与 pi 一致）—— 等完了，它们的工具才注册完。
    const sections = await extensionHost.collectPromptSections();
    // **声明给模型**的工具在这一刻定下：激活集 ∩ 注册表，再跑一遍 `prepareLoadout`
    // （codemode 靠它把自己的描述换成「现在能调哪些工具」的清单）。
    const declared = declaredToolset(cwd);
    const declaredNames = new Set(declared.tools.map((tool) => tool.name));
    // Skill 清单：官方 `DefaultResourceLoader` 扫各个目录（`~/.pi/agent/skills`、
    // `<cwd>/.pi/skills`、cwd 与祖先的 `.agents/skills`、`~/.agents/skills`），
    // 目录发现与重名判定与 pi 逐字相同；再由 reducer 拼进 system prompt
    // （走 prompt.init，所以会被落盘、被回放）。
    //
    // 加载**失败不能拖垮启动**：一个写坏 frontmatter 的 skill 不该让整个界面起不来
    // （loadSkillRegistry 已经把异常收成 diagnostics 了）。
    //
    // 诊断**不打到 stderr**：TUI 模式下 stderr 用户看不见，而「某个 skill 没加载上」
    // 正是静默退化（模型少了能力，界面与用户都不知道）。它们进 state，由界面开场显示
    // （与 pi 的 `[Skill conflicts]` 同形）。
    const skillRegistry = await loadSkillRegistry({ cwd, ...(options.skillPaths ? { paths: options.skillPaths } : {}) });
    // Prompt 模板：与 skill 同一条装载链（`DefaultResourceLoader`），所以 pi 包清单里
    // `pi.prompts` 声明的模板（比如 pi-subagents 的 `/council`）在这里也会出现。
    // 它们**不进** system prompt，只进状态给界面用（开场横幅 / 补全 / 回车展开）。
    const promptRegistry = await loadPromptRegistry({ cwd });
    // System prompt 由 **pi 的 buildSystemPrompt** 拼（工具规则 / AGENTS.md / cwd / skill）。
    // 我们只收集输入：工具的 snippet+guideline、AGENTS.md 上下文、skill 清单。
    //
    // 为什么在这里（而不是让调用方传一整串进来）：工具清单是内核按 cwd 建的，
    // AGENTS.md 与 skill 都随 cwd 变 —— 拼 prompt 需要的正是这三样，所以它属于内核这一步。
    //
    // **扩展工具与官方工具走同一条路**（同一个 `PromptToolLike` 形状、同一套筛选规则），
    // 所以在 prompt 里它们没有区别 —— 「没有 promptSnippet 就不列」那条官方语义也照样
    // 适用（那种工具模型看不到，而那是有意的：见 extension-host.ts 里的诊断）。
    const promptTools: PromptToolLike[] = [
      ...promptToolsFrom(cwd),
      ...extensionHost.promptTools,
      // 只列**这一轮真的声明给模型**的（没声明的与隐藏的都不算）：
      // MCP 的 codemode 工具没激活时不进工具表，而 codemode 的 `mode: "only"`
      // 会把直调工具从声明里藏掉（它们仍可被脚本调）。
    ].filter((tool) => declaredNames.has(tool.name) && !declared.hidden.has(tool.name));
    const { text: systemPrompt, sections: promptSections } = buildPromptParts({
      cwd,
      tools: promptTools,
      skills: skillRegistry.skills,
      ...(Object.keys(sections).length > 0 ? { sections } : {}),
      ...(options.systemPrompt !== undefined ? { customPrompt: options.systemPrompt } : {}),
      ...(options.appendSystemPrompt !== undefined
        ? { appendPrompt: options.appendSystemPrompt }
        : {}),
    });
    store.dispatch({
      type: 'prompt.init',
      systemPrompt,
      // 分段与整段一起装：整段是发给模型的那份，分段是「以后按段 patch」的原料
      // （见 `prompt-head.ts` 与 `system-prompt.ts` 的 `buildPromptParts`）。
      sections: promptSections,
      tools: declared.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      skills: skillRegistry.skills,
      skillDiagnostics: skillRegistry.diagnostics,
      promptTemplates: promptRegistry.prompts,
      promptDiagnostics: promptRegistry.diagnostics,
    });
    // 工具集**不是**定死的：之后 `setActiveTools`（`web_enable` / `subagents_enable`
    // 那些 loader 工具）真的会改声明，而变更由 `agent.run` 在请求前 diff 成一条
    // `toolsAdded` / `toolsRemoved` 消息声明出去（见 `prompt-head.ts`）。
  };

  // 现场装满还是推到后台：见 `KernelOptions.deferExtensions` 与 `Kernel.ready`。
  let ready: Promise<void>;
  if (options.deferExtensions === true) {
    ready = assembleExtensions().catch((error) => {
      // 这一档下**不抛**：界面已经在跑了（首帧画完了），抛出去没人接 —— 收成诊断，
      // 界面读 `extensions.errors` 时会看到（与「一个扩展装不上」同一个口径）。
      deferredErrors.push(
        `扩展装载失败（界面不带扩展继续）：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else {
    await assembleExtensions();
    ready = Promise.resolve();
  }

  // 装载段落盘：**写进同一个轨迹文件的前两行**（不再单独一个 `<id>.init.jsonl`）。
  // 有了它，回放时不必重装配工具、不必再问 provider「这个模型支持中途插 system 吗」。
  //
  // ## 什么时候写：用户发出第一句话之后（不是内核一装配）
  //
  // 与会话文件那边同一个决定：「进来看一眼就退出」不该在盘上留一个只有装载段、
  // 零条对话的文件。所以内核**不在这里调它**，而是在 store 里盯住
  // `traceBegun` 翻转的那一刻（见下面那个订阅）。
  //
  // 走 delegator（同一个 sink）而不是另开一个文件：少一半文件，目录里全是 jsonl 很难翻。
  // 位置在几条 add 记录之后（`tools` 要从 store 读，那上面才有完整的工具定义，
  // 而装载节点由 user.message 开出并先被 flush）—— 这没问题：回放是按 op 类型收集的，
  // 与行的先后无关。

  const writeInit = (): void => {
    const capabilities = readCapabilities(runtime.model);
    // **从 state 读**而不是从装配那一层的闭包读：`deferExtensions` 下 prompt 是后装的
    // （而这段又恰好在「用户发出第一句话」那一刻才跑），读 state 就是「当时生效的那份」
    // 这个定义本身 —— 两份闭包常量反而会多出一个「谁更真」的问题。
    const promptState = store.getState().prompt;
    const promptSkills = promptState.skills ?? [];
    const records: InitRecord[] = [
      {
        op: 'prompt.init',
        // 落**拼好的那一整段**（不是 customPrompt 的原文）：回放时要能重建
        // 「当时发给模型的到底是什么」，而 AGENTS.md 与 skill 清单都可能已经变了。
        systemPrompt: promptState.systemPrompt,
        // 分段一并落：中途的 prompt 变更只 patch 变了的段，回放时靠它还原
        // 「当时有哪几段」（没有它就只能整段替换，见 `prompt-head.ts`）。
        sections: promptState.sections ?? {},
        tools: promptState.tools,
        // skills 一并落：回放时要知道当时有哪些 skill（它们拼进了 prompt）。
        ...(promptSkills.length > 0 ? { skills: promptSkills } : {}),
      },
      {
        op: 'model.init',
        provider: runtime.spec.provider,
        modelId: runtime.model.id,
        thinkingLevel,
        reasoning: runtime.model.reasoning ?? false,
        capabilities,
      },
    ];
    void delegator.append(records.map((r) => JSON.stringify(r)).join('\n'));
  };

  //
  // 「会话已开始」的信号 → 写装载段。
  //
  // 订阅而不是让界面/调用方来通知：判据是 `state.traceBegun`，而它是 reducer 在**第一条
  // user.message** 里置上的（与装载节点同一刻）。于是「什么时候算这段会话开始」只有一个定义，
  // 不依赖每个调用方记得调 writeInit —— 忘了就等于这次会话的 init 段永远缺失（回放时
  // 只能重新装配工具）。
  //
  // **必须先于落盘器的 flush**（顺序理由见下面 activeSink 的注释）：落盘器是 store 订阅器，
  // 而这个也是。订阅者按注册的顺序被通知，而本文件里 createPersistentStore 在前，
  // 于是顺序反了 —— 所以这里不靠订阅顺序，而是**绕一圈**：
  // 观察到的变化（traceBegun 翻转）恰好让 delegator 放行，落盘器那一轮 flush 就会先把
  // 装载节点的 add 写出去；init 记录补在**后面**一行，而回放按 op 收集、与行序无关
  // （这正是 init 记录从一开始就与 add 记录混在同一个文件的前提）。
  //
  // `restoreSession` 灌回的是**已经**有轨迹文件的历史：那棵树的 init 段在文件里，
  // 所以那里把 `wroteInit` 直接置真，再补一份就是磁盘上的垃圾行。
  let wroteInit = false;
  const unsubscribeStart = store.subscribe(() => {
    if (wroteInit) return;
    if (!store.getState().traceBegun) return;
    wroteInit = true;
    writeInit();
  });

  //

  return {
    store,
    runtime,
    /**
     * 当前会话 id。**会变**（`newSession()` / 恢复历史），所以是取值而不是常量。
     *
     * 读的是 **store 里那一个**（`state.session.id`）—— 它才是「会话身份」的真相，
     * 而 `current.sessionId` 是内核自己的**资源句柄**（轨迹 sink / 会话文件绑在哪个 id 上）。
     * 两者在每次 dispatch 之后一致（`conversation.reset` / `conversation.restored` 都带 id），
     * 但对外只暴露 store 那份：TUI 与 web 都从同一个地方取值。
     */
    get sessionId(): string {
      return store.getState().session.id;
    },
    persistence,
    /** 当前会话记录器（换会话后指向新的那个）。 */
    get session(): SessionRecorder | null {
      return current.recorder;
    },
    /**
     * 换模型：一条 `model.changed`（载荷与 `model.init` 一样，带全能力 / 窗口）。
     *
     * ## 先查存在再 dispatch
     *
     * 从 `runtime.models` 取那个 Model 对象 —— 能力与 contextWindow 都从它读。
     * **取不到就不 dispatch**：那说明配置与当前目录对不上（比如 `models.json` 刚被改坏），
     * 此时让状态停在一个「说要用某个模型、但没人知道它的能力」的状态比拒绝更糟 ——
     * 底栏会显示一个新名字，而请求会带着**清零的能力**发出去。
     *
     * 为什么不**换掉** `runtime.spec` / `runtime.model`：那是降级路径之外的**初始**装配，
     * `extensionModelRegistry()` / `createRuntime()` 那些都还指着它。改那两个字段等于
     * 「把历史也改了」——`/new` 之后本该能回到命令行给的那个模型，而现在回不去了。
     * effect 表是每次请求现取的（`store.ts` 的 `resolveModel`），所以只换 state 就够。
     */
    setModel(
      provider: string,
      modelId: string,
      modelOptions?: { thinkingLevel?: string | undefined },
    ): boolean {
      const model = runtime.models.getModel(provider, modelId);
      if (!model) return false;
      // 换模型之后用哪一档：逐条照抄 pi 的 `_getThinkingLevelForModelSwitch` +
      // `setThinkingLevel` 里的 clamp ——
      // 作用域条目写死的档位（`/scoped-models` 的 `p/i:high`）→ per-model 覆盖 →
      // 全局默认 → **当前那一档**（pi 的 `?? this.thinkingLevel`）。
      //
      // 为什么不是「一律带着旧级别走」：那是本项目早先的行为，而它与 pi 在**配过**
      // `defaultThinkingLevel` / `modelThinkingLevels` 的人那里不一致 —— 症状正是
      // 「pi 换过去是 high、本项目换过去还是旧的 low」。没配过时两条规则结果相同
      // （全局默认没有 → 退回当前值），所以这个改动对默认配置无感。
      //
      // clamp 在这里是必需的：换到一个只认 high/max 的模型而手上是 medium，
      // 不夹就会发出模型不认的 reasoning 值。
      const thinkingLevel = thinkingLevelForModelSwitch(model, {
        scopedLevel: modelOptions?.thinkingLevel,
        perModelLevel: readModelThinkingLevel(provider, modelId, cwd),
        defaultLevel: readDefaultThinkingLevel(cwd),
        current: store.getState().model.thinkingLevel,
      });
      const state = store.getState();
      const previousModel = { provider: state.providerName, id: state.modelId };
      store.dispatch({
        type: 'model.changed',
        provider,
        modelId,
        thinkingLevel,
        reasoning: model.reasoning ?? false,
        capabilities: readCapabilities(model),
        contextWindow: model.contextWindow ?? 0,
      } as AgentAction);
      // pi 的 `model_select`：扩展靠它把「当前模型」显示出来（Orca 的模型选择器）。
      // 只有在真的变了时才发（与 pi 的 `_emitModelSelect` 一致：同一个模型不重发）。
      if (previousModel.provider !== provider || previousModel.id !== modelId) {
        recordLifecycle({
          type: 'model_select',
          model: { provider, id: modelId },
          previousModel,
          source: 'set',
        });
      }
      return true;
    },
    /**
     * 开一个新会话：换 sessionId（于是换文件），清空对话。
     *
     * 为什么不复用 `conversation.reset`：那个默认沿用原 id，之后的消者会追加进
     * **同一个文件** —— 界面上看着像新会话，实际上把上一段历史续写了（这是之前的 bug）。
     *
     * 顺序要紧：先把旧的收掉（flush 缓冲），再换资源，最后 dispatch。反过来的话
     * `conversation.reset` 一发生，旧记录器还会把「清空」这件事当成一次状态变化去写。
     */
    newSession(): { id: string } {
      const previous = current;
      const id = newSessionId();
      const next = openResources(id);
      current = next;
      // 旧记录器先摘掉：它绑在旧 id 上，不该再往旧文件写。
      previous.recorder?.dispose();
      // 新会话从头来：又变成「还没说话」，于是装载节点与 init 记录都重新推迟到第一句话。
      // （`conversation.reset` 建的 fresh state 里 traceBegun 本来就是 false，
      //   但这里要在 dispatch **之前**清 wroteInit —— 那个订阅器在 dispatch 时就会看到
      //   「已经开始了」，从而给一个空会话写 init。）
      wroteInit = false;
      store.dispatch({ type: 'conversation.reset', sessionId: id } as AgentAction);
      openRecorder(id);
      // 旧 sink 收尾（把缓冲 flush 掉）。
      if (previous.sink?.close) void previous.sink.close();

      return { id };
    },
    /**
     * 自动压缩的开关。
     *
     * 读的是**活着的那个对象**（而不是重读 settings）：`/settings` 里刚关掉之后
     * 那一行得显示 `false`，而盘上的值要等异步写落盘 —— 读盘会读到一个旧值，
     * 症状是「关了两下才关掉」。
     */
    autoCompactEnabled(): boolean | null {
      return autoCompact === null ? null : autoCompact.enabled();
    },
    /**
     * 写盘失败**不报错也不回滚**：与 pi 的 `setCompactionEnabled()` 同一处理，
     * 而「关不掉」比「关掉了但没存住」严重得多（前者当场就看得见）。
     */
    setAutoCompactEnabled(enabled: boolean): void {
      autoCompact?.setEnabled(enabled);
      void writeCompactionEnabled(enabled, cwd);
    },
    /**
     * 恢复一个历史会话：读文件、清空当前对话、把消息**一次**灌回去，
     * **并把那一段的轨迹树也读回来**。
     *
     * **零 token** —— 不重跑模型。状态只能由 action 改（本项目的不变式），所以走一条
     * `trace.restored`：它把「换会话 + 灌消息 + 带上轨迹树」合成了一次 dispatch。
     * 分开发的话恢复 390 条消息要重渲染 390 次整屏（实测 62 秒）。
     */
    async restoreSession(file: string): Promise<{ id: string; restored: number }> {
      const session = readSession(file);
      const messages = session ? sessionMessages(session) : [];
      // 这一段的思考级别也一并读：pi 恢复会话时会把那一档带回 agent state
      // （`core/sdk.js:122-127`、`session-manager` 的 `getSessionContextSettings`）。
      const thinking = session ? sessionThinking(session) : undefined;
      const id = session?.header.id ?? '';
      // 恢复也换 id：之后的消息要追加进**那个**会话的文件，而不是当前这个。
      const previous = current;
      previous.recorder?.dispose();
      current = openResources(id);
      // 轨迹树也要读回来。早先只读消息，于是恢复后对话区有内容（含粘贴的图片），
      // 而轨迹面板**空的** —— 而 `traces/<时间戳>_<id>.jsonl` 明明在盘上。
      // 那个症状特别有欺骗性：图像看得见、消息都在，只有轨迹没了。
      //
      // 读不到（旧会话、或当时开了 --no-trace）不是错误：那就发不带树的那条 action，
      // 行为与修复前完全一致。
      const traceDir = options.traceDir;
      const tree =
        id !== '' && traceDir !== null ? await loadTrace(id, traceDir ?? undefined) : null;
      // 轨迹落盘器的游标也要跟着推 —— 它只看 messages 有没有变长，看不出这些是「读回来的」
      // 而不是「新产生的」。不推的话，它会把整批历史当新消息重写一遍，
      // 于是轨迹文件里同一批消息出现两次。
      //
      // 必须在 dispatch **之前**调：flush 是 store 订阅器，dispatch 一发生就晚了。
      persistence?.skipMessages(messages.length);
      // 恢复进来的会话**已经有** init 段了（那个会话当初也发过话），别再补一份。
      wroteInit = true;
      store.dispatch(
        (
          tree === null
            ? {
                type: 'conversation.restored',
                sessionId: id,
                messages,
              }
            : { type: 'trace.restored', sessionId: id, messages, trace: tree }
        ) as AgentAction,
      );
      // 思考级别跟着会话走（在**恢复之后**发：那两条 restored action 会把 model 块里
      // 的级别按当前值带上，先发会被它们的值盖回去）。
      //
      // 没有那条记录（老会话）就不动 —— 保持启动解析出来的那一档，与 pi 的
      // `hasThinkingEntry ? existingSession.thinkingLevel : <默认解析>` 同一行为。
      // clamp 仍然要过：恢复的那个会话可能是用另一个模型聊的（本项目不在恢复时换模型），
      // 而旧档位在新模型上未必合法。
      if (thinking !== undefined && isThinkingLevel(thinking.level)) {
        const state = store.getState();
        const restoredLevel = clampForModel(
          runtime.models.getModel(state.providerName, state.modelId),
          thinking.level,
        );
        if (restoredLevel !== state.model.thinkingLevel) {
          store.dispatch({ type: 'thinking.changed', level: restoredLevel } as AgentAction);
        }
      }
      // 恢复出来的消息已经在文件里，记录器游标要从这里接着算，别再写一遍。
      // 第三个参数：这个文件里已经有 `thinking_level_change` 吗 —— 没有就由记录器回填一条
      // （与 pi 的 `sdk.js:279-283` 同一件事）。
      openRecorder(id, messages.length, thinking?.hasEntry === true);
      if (previous.sink?.close) void previous.sink.close();

      return { id, restored: messages.length };
    },
    restore(messages: Message[]): void {
      for (const message of messages) {
        store.dispatch({ type: 'session.restored', message } as AgentAction);
      }
    },
    extensions: extensionView,
    ready,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      unsubscribeStart();
      unsubscribeAgentLifecycle();
      autoCompact?.dispose();
      current.recorder?.dispose();
      persistence?.dispose();
      // flush 轨迹落盘：**要等**（一次性模式末尾紧接着 `process.exit()`，不等会截断还没写下去的字节）。
      const sinkClosed = current.sink?.close?.();
      // **扩展宿主要等**：MCP 的 stdio 子进程握着事件循环，不等它们关掉进程退不出去
      // （一次性模式尤其明显，见 `Kernel.dispose()` 的接口注释）。
      // `deferExtensions` 下这里收的是占位宿主；后台装载那一路拿到真宿主后会看到
      // `disposed` 并自己收（见 `assembleExtensions`）。
      await extensionView.dispose();
      try {
        await sinkClosed;
      } catch {
        // 关不干净不该让退出卡住。
      }
    },
  };
}
