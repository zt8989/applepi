/**
 * 内核 —— 整个应用**唯一**跑环的地方。
 *
 * 只有一个权威 Loop：界面层只是渲染层（订阅 store、画状态、把输入 dispatch 回去）。这不是洁癖
 * 而是必需的 —— 另有一处跑环就会出现「两处都发起 LLM 调用」「两处消息流不一致」，而环本身是有
 * 副作用的（真的调模型、真的改文件）。
 *
 * 装配一次得到 `store`（环的收敛点）与 `persistence`（轨迹落盘器，错误也落盘）。
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
import { declaredToolset, resetTools } from './tools';
import { buildPromptParts, buildSystemPromptText, promptToolsFrom, type PromptToolLike } from './system-prompt';
import { loadExtensionHost, extensionMessageAction } from './extension-host';
import type { HostUiOptions } from './extension-ui';
import type { ExtensionHost } from './extension-host';
import { loadSkillRegistry } from './skills';
import { loadPromptRegistry } from './prompts';
/**
 * 从 Model 对象上读我们关心的三个能力。位置不一样：`supportsMidConvo*` 在 **BaseModel** 顶层，
 * `supportsDeveloperRole` 在 **compat** 里（只有 openai 一族有）。
 *
 * 读不到就当 false（保守）：「以为支持但实际不支持」会让 pi-ai 把消息发出去然后被 provider 拒，
 * 那种失败长得像「随机 400」。导出是因为 `setModel()` 与测试要用**同一个读法** —— 两处各写
 * 一份会漂移，症状是「底栏换了、实际请求还是按旧能力发」。
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
  /** 一次 LLM 调用的空闲超时（毫秒）：流上这么久没有任何事件就掐。 */
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
   * **不等扩展装载**：`createKernel()` 在 store 与 `model.init` 就绪之后就返回，扩展装载
   * （jiti，实测 2~3s）与它后面的 prompt 装配在**后台**跑，`kernel.ready` 表示「装完了」。
   *
   * 需要它是因为交互式界面的首帧要等 `createKernel()` 返回，而那 2~3s 全在扩展装载上。
   * 打开这一档之后：
   *
   * 1. **`ready` 之前不许发消息**：那一刻 `state.prompt.tools` 还是「没有扩展」的形状，先发的
   *    消息会把缺工具集的 head 写进会话与轨迹（head 是不可改的历史）。界面把发送挂在 `ready` 上，
   *    一次性模式**不打开这一档**。
   * 2. **`kernel.extensions.*` 是活视图**：界面不能把「现在读到的内容」当成终局，开场横幅要在
   *    `ready` 之后重报一次。
   *
   * 这一档下装载失败**不抛**（界面已经在跑），收进 `kernel.extensions.errors` 由界面报出来；
   * 默认那条路照旧往外抛 —— 一次性模式该响亮地失败。
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
   * 必须转发**每次读**：`ready` 之前它指向一个**空宿主**、就绪后指向真的那个，而界面在
   * `createKernel()` 返回时就把里面几个引用抓走了（`extensions.commands`、开场横幅那份
   * `entries`）—— 换对象等于它们永远看到空的那份，症状是「扩展的斜杠命令不见了」且没有报错。
   * 代价是「读到的内容会变」，界面据此在 `ready` 之后重报一次开场。
   */
  readonly extensions: ExtensionHost;
  /**
   * 扩展装载完成（`deferExtensions` 时才有意义；否则一开始就是已完成的）。
   *
   * **不会 reject**：`deferExtensions` 下装载失败收进 `extensions.errors`，
   * 这一条照常完成 —— 界面不能卡在「正在装载」上。
   */
  readonly ready: Promise<void>;
  /**
   * 开一个新会话：换 id（于是换文件）、清空对话。**不会**把新消息写进旧文件。
   *
   * 扩展那一半是**异步**的：换会话 = 换一次扩展激活（`session_shutdown` → 重装宿主 →
   * `session_start`），与 pi 的 `newSession()` 同序。这里不等它（`/new` 是同步入口），
   * 但重装完成前要真用宿主的地方（`beforeAgentStart` / `tool_call`）会自己等。
   */
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
   *
   * 换到**另一个**会话时，返回前扩展已经在新会话上重新激活（与 pi 的 `switchSession()`
   * 同序：旧激活 `session_shutdown` → 新实例 `session_start`）；恢复的是同一个会话则不动扩展。
   */
  restoreSession(file: string): Promise<{ id: string; restored: number }>;
  /** 把已经读出来的消息灌回 state。 */
  restore(messages: Message[]): void;
  /**
   * 重载（`/reload`）：重新读 settings / 扩展 / skill / prompt 模板 / 上下文文件。
   *
   * 与 pi 的 `AgentSession.reload()` 同一个语义：旧激活 `session_shutdown{reason:'reload'}`
   * （`pi-background-tasks` 在这个 reason 下做 handoff，存活中的后台任务不丢）→ 装新扩展实例
   * → `session_start{reason:'reload'}`（MCP 重读 `mcp.json`）→ 重拼 system prompt 与工具声明。
   *
   * 环在跑时拒绝（`ok: false`）：那一刻重装宿主会把正在等的流 / 工具交给一个已 shutdown 的宿主。
   * 它也会排队在会话切换后面 —— 与 `newSession` / `restoreSession` 共用同一条宿主链。
   */
  reload(): Promise<KernelReloadReport>;
  /**
   * 换模型。**真换** —— 之后的每个回合都发给新的那个。
   *
   * `model.changed` 带**整套**模型参数（与 `model.init` 载荷完全一致）：能力与窗口是模型之间
   * 不一样的，一个支持中途插 system 的网关换成一个不支持的、还按旧的来会发出 provider 拒收的
   * 请求（那种失败长得像「随机 400」）。所以一步把能力 / 窗口装到位，不需要「先保守清零再补」。
   *
   * 两条 action 只差语义：`model.changed` 是「**切**成了什么」（轨迹里看得见），`model.init`
   * 是「**装载**了什么」。
   *
   * 思考级别不是「带着走」而是按 pi 的 `_getThinkingLevelForModelSwitch` **重新解析**（作用域
   * 条目 / per-model 覆盖 / 全局默认排在「当前这一档」前面，最后 clamp）—— 没配过 settings 时
   * 结果与带着走相同，配过时才分得出来。
   *
   * @returns 换成功没有。找不到那个模型就返回 `false` 并**不 dispatch**。
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
 * `/reload` 的回执。
 *
 * 不给「重载了几样东西」的计数（那是实现细节）：界面只要知道成功 / 失败，以及重装后
 * 该报哪些诊断（skill 冲突、prompt 模板冲突、扩展装载错）。
 */
export interface KernelReloadReport {
  ok: boolean;
  /** 失败原因（`ok: false` 时给界面直接显示）。 */
  message?: string | undefined;
  /** 重装后的诊断 —— 与开场横幅那几节同一个口径（`[Skill conflicts]` 那种）。 */
  diagnostics: string[];
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

/** 诊断信息的统一形状（扩展报的错有时是字符串、有时是 Error）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    // 轨迹与 sessions/ 同一套 cwd 编码目录（`traces/--<cwd>--/`）；显式 --trace-dir
    // 仍然优先（测试 / 自定义布局）。cwd 在下面才解析，这里先用 options 重算一遍。
    const resolvedCwd = path.resolve(options.cwd ?? process.cwd());
    return {
      sessionId: id,
      sink:
        dir === null
          ? undefined
          : createFileSink(tracePath(id, dir ? { cwd: resolvedCwd, dir } : { cwd: resolvedCwd })),
      recorder: null, // 由下面的 openRecorder 填（它要等 store 建好）
    };
  };

  let current: SessionResources = openResources(options.sessionId ?? newSessionId());
  const sessionId = current.sessionId;
  const cwd = path.resolve(options.cwd ?? process.cwd());

  // 思考级别的顺序：命令行 > 会话文件里那条 > per-model 覆盖 > 全局默认 > 内置 `medium`，
  // 最后 clamp 到当前模型支持的那几档。三个坑：
  //
  // 1. **只在命令行真的给了 sessionId 时才去扫会话目录**：不给时 sessionId 是刚生成的 UUIDv7，
  //    盘上一定没有，而扫目录是启动路径上唯一的文件系统操作。
  // 2. 「文件在那」不等于「这是一个已有的会话」：pi 的 `hasExistingSession` 是
  //    `messages.length > 0`（空壳文件不算），不算时它走「新会话」分支（per-model 覆盖**会**被
  //    看到）。差别只在那一个布尔值上，照抄。
  // 3. clamp 在这里做（这个函数知道 model）：`medium` 在 deepseek-v4.1-flash 上不是合法档位，
  //    不夹就是「底箱写着 medium，请求里发的是模型不认的 reasoning 值」。
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
   * 只此一个函数：轨迹树是 action 的产物，而扩展是当场就要收到事件的，两件事各写一遍必然漂。
   *
   * dispatch 排在 emit 前面：`emitLifecycle` 会同步跑扩展的 handler，而 handler 可能又去
   * dispatch（`pi.sendMessage` 之类）—— 先把事实写进状态再通知别人，扩展读到的状态才不缺这条。
   *
   * 循环风险：dispatch 会再触发订阅器，那一路看 `phase` 有没有变、没变就 return，嵌套一层即停。
   */
  function recordLifecycle(event: ExtensionLifecycleEvent): void {
    store.dispatch({ type: 'extension.lifecycle', event } as AgentAction);
    extensionHostRef?.emitLifecycle(event);
  }

  const { store, persistence, autoCompact } = createPersistentStore({
    runtime,
    // `tool_call` 门：MCP 靠它等「脚本/模型点名了但服务器还没连上」。
    //
    // 先等 `hostSwitch`：切会话时宿主要**重装**（见下面的 `switchExtensionHost`），
    // 那一刻旧宿主的 MCP 已断、新宿主还没好。不等就会把工具调用递到一个死掉的宿主上。
    onToolCall: async (toolCallId, name, input) => {
      await hostSwitch;
      return currentHost().beforeToolCall(toolCallId, name, input);
    },
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

  // 相位级生命周期事件（`agent_start` / `agent_end` / `agent_settled`）用订阅器发：reducer 是
  // 纯函数，发事件不属于它，而「环刚停下来」在 redux-loop 里没有对应的 action（见 store.ts）。
  //
  // 事件走 `recordLifecycle()`：先记进轨迹，再发给扩展。宿主还没装上时只是没人收，**记录照旧**
  // —— 轨迹是历史，不该因为那一刻没有监听者就漏掉真实发生过的事。
  //
  // `agent_start` 是 idle → 非 idle；`agent_end` / `agent_settled` 是反过来那一下，**两个一起发**
  // （pi 的 `agent_end` 是「这一轮结束」，`agent_settled` 是「真的静了」，相位回 idle 就是两者同时
  // 成立的那一点）。扩展自己按 `agentSettledSupported` 决定认哪个，所以不替它选。
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

  //
  // 见 `Kernel.extensions` 的注释（为什么不能直接换对象）。
  //
  // 就绪前指向一个**空宿主**：与 `--no-extensions` 同形（工具表只有官方那几个、
  // 命令表空、`beforeToolCall` 原样放行），界面在这段时间读到的就是「没有扩展」——
  // 那是一个**少东西但一致**的状态，而不是 undefined（后者会让界面在 `entries` 上炸）。
  const placeholderHost = await loadExtensionHost({ store, cwd, disabled: true });
  const deferredErrors: string[] = [];
  /** 切会话时**重新装宿主**失败的那几条（装载失败是 `deferredErrors`，两回事）。 */
  const hostErrors: string[] = [];
  /** 已经 `dispose()` 了 —— 后台装载完成时不能再往界面上递一个活着的宿主。 */
  let disposed = false;
  /** 扩展装载完成；`switchExtensionHost` 要先等它（`deferExtensions` 下才有真的等待）。 */
  let ready!: Promise<void>;
  /**
   * 当前这一轮扩展激活**绑在哪个会话上**（`session_start` 成功那一刻的 id / 计划文件）。
   *
   * 切会话的判据不是「调了 `newSession` 几次」，而是「要切的会话和宿主当前绑的不是同一个」：
   * 恢复**同一个**会话（webui 点侧边栏当前那一条、启动时 `--session <id>` 后再 restore）
   * 不该无谓地重装一遍扩展。
   */
  let hostSessionId: string | undefined;
  let hostSessionFile: string | undefined;
  /** 正在跑（或排队中）的宿主重装。所有要等「扩展真的就绪」的地方都 `await` 它。 */
  let hostSwitch: Promise<void> = Promise.resolve();
  /** 排队中的那次切换（连续切会话时只保留最新的一个 reason）。 */
  let pendingSwitch: 'new' | 'resume' | undefined;
  const currentHost = (): ExtensionHost => extensionHostRef ?? placeholderHost;
  /**
   * 等宿主稳定（重装跑完了）再拿它。
   *
   * 切会话的重装是异步的（jiti 重装扩展 + MCP 重连），而 TUI / 浏览器可能在那一瞬已经
   * 能发下一句了 —— 不等就会把这一轮交给一个已经 `session_shutdown` 过的旧宿主，症状是
   * 「切完会话第一句没有扩展的 prompt 段 / 工具突然不可用」。
   */
  const activeHost = async (): Promise<ExtensionHost> => {
    await hostSwitch;
    return currentHost();
  };
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
    // 诊断是**三份**：当前宿主自己的 + 后台装载整体失败的 + 切会话重装失败的。
    get errors() {
      return [...currentHost().errors, ...deferredErrors, ...hostErrors];
    },
    get entries() {
      return currentHost().entries;
    },
    get loaded() {
      return currentHost().loaded;
    },
    beforeAgentStart: async (text?: string) => (await activeHost()).beforeAgentStart(text),
    startSession: async (...args: Parameters<ExtensionHost['startSession']>) =>
      (await activeHost()).startSession(...args),
    collectPromptSections: async () => (await activeHost()).collectPromptSections(),
    // 参数用 `Parameters<…>` 原样透传（包括第四个 `options`）：这里少转发一个参数
    // 就是一行静默的降级（权限类扩展会丢掉 signal，而症状离真因很远）。
    beforeToolCall: async (...args: Parameters<ExtensionHost['beforeToolCall']>) =>
      (await activeHost()).beforeToolCall(...args),
    // 同样逐次转发：后台装载完成后，早先抱着的「空宿主」视图里这个方法就指向真宿主了
    // （否则就绪前发出的那些事件永远发不到扩展上）。
    //
    // **不 await `hostSwitch`**：`emitLifecycle` 是同步入口（store 订阅器发的），而事件是
    // 当下的事实 —— 重装窗口里丢一条状态事件，比把相位订阅器变成异步、打乱顺序好。
    emitLifecycle: (event: Parameters<ExtensionHost['emitLifecycle']>[0]) =>
      currentHost().emitLifecycle(event),
    dispose: async () => (await activeHost()).dispose(),
    shutdown: async (options) => (await activeHost()).shutdown(options),
  };

  // 装载走 action 而不是直接写进 `createInitialState`：「装载」与「跑一轮对话」都是状态迁移，
  // 走 action 才能被落盘、被回放 —— 回放时读到 init 段就知道当时发给模型的是什么。
  //
  // 两块拆开是因为 model 不依赖扩展、prompt 依赖：`deferExtensions` 只把 **prompt 那一块**推到
  // 后台。底栏首帧就要显示 `(provider) model`，把它留到后面的话，扩展装载那几秒里底栏是
  // `()`（看着像坏了）。
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

  // 会话记录器**必须在扩展装载之前建**：扩展的 `ctx.sessionManager.getSessionFile()` 要报「这个
  // 会话的文件是哪个」，而它在 `session_start` 那一刻被读走、之后不再刷新。Orca 那类宿主靠这个
  // 路径认「对话记录在哪」，拿不到就一直显示 loading。
  //
  // 报的是**计划路径**（`SessionWriter.path`），不是「文件已在盘上」：空会话不建文件，而状态
  // 扩展读的时候自己会 `existsSync` 重试，第一条消息落盘后那份元数据就真的带上去了。
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

  /**
   * 装一份**新的**扩展宿主（同一批扩展、全新实例）。
   *
   * 切会话要重装（而不是把事件再发一遍给旧实例），因为 pi 的会话切换就是「收掉旧激活、
   * 建新激活」（`AgentSessionRuntime` 的 `teardownCurrent` + `createRuntime`）：扩展实例
   * 是**激活级**的，`pi-background-tasks` 在 `session_shutdown` 里就把自己标成 disposed，
   * 再给它发 `session_start` 会被直接忽略；而且它只接受「同一个会话身份」的重复
   * `session_start`，换了会话会报 `pi_bg_reload_owner_activation_conflict`。
   *
   * `loadExtensions()` 用的是 `moduleCache: false` 的 jiti（见官方 loader），所以再调一次
   * 就是重新求值扩展模块 → 新的 handler 闭包，与 pi 每次切会话重建 runner 同一个效果。
   */
  const createExtensionHost = (): Promise<ExtensionHost> =>
    loadExtensionHost({
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
      // 扩展的 `pi.sendMessage` 落到哪里：空闲时一条**用户消息**（于是环会跑起来），
      // 与界面里敲一句话同一条路；环在跑时按 `deliverAs` 排队 —— 见
      // `extensionMessageAction` 的注释（直接发 `user.message` 会被 reducer 丢掉）。
      onSendMessage: (text, options) => {
        const action = extensionMessageAction(text, options, store.getState().phase);
        if (action === null) return;
        store.dispatch(action);
      },
      canSend: () => store.getState().phase === 'idle',
    });

  /**
   * 切会话 → 换一次扩展激活（`session_shutdown{reason}` → 重装 → `session_start{reason}`）。
   *
   * ## 为什么不能只「再发一次 `session_start`」
   *
   * 那正是之前的做法（见 `efc96e4`），在 `pi-background-tasks` 这类**按会话认所有权**的
   * 扩展上是不合法的：它在 `session_start` 里用 `(pid, sessionId, cwd)` 当 reload 所有权
   * 身份，重复的 `session_start` 换了身份就直接抛
   * `pi_bg_reload_owner_activation_conflict: a repeated session_start changed the bound reload
   * owner identity without shutdown`，而这条异常会以「扩展装载诊断」的形式出现在设置页里、
   * 后台任务从此不可用。
   *
   * pi 的做法是 `teardownCurrent()` 先发 `session_shutdown`、再 `createRuntime()` 用新实例
   * 发 `session_start` —— 这里照那个顺序做。
   *
   * ## 并发
   *
   * 重装是异步的（jiti 重装 + MCP 重连），而 `/new` 是同步入口。所以这里排队：
   * `hostSwitch` 是「宿主稳定」的信号，所有要真的用宿主的地方先 `await` 它（见 `activeHost`）；
   * 连续切会话时只按**最新**那一个 reason 跑一遍（`pendingSwitch`），已经在目标会话上就不重装。
   */
  const switchExtensionHost = (reason: 'new' | 'resume'): Promise<void> => {
    // `--no-extensions`：宿主是个空壳，换会话没有东西可重装。
    if (options.noExtensions === true) return Promise.resolve();
    pendingSwitch = reason;
    const run = async (): Promise<void> => {
      const queuedReason = pendingSwitch;
      pendingSwitch = undefined;
      if (queuedReason === undefined || disposed) return;
      // `deferExtensions` 下装载可能还在跑：等它完（`ready` 不 reject）。
      await ready;
      await rebindHost(queuedReason, false);
    };
    hostSwitch = hostSwitch.then(run, run).catch((error: unknown) => {
      hostErrors.push(`扩展切换失败：${errorText(error)}`);
    });
    return hostSwitch;
  };

  /**
   * 把宿主重绑到**当前**会话上：`session_shutdown` → 装载新实例 → `session_start`。
   *
   * @param force 会话没变也重来一遍（`/reload`）；`/new` / `/resume` 给 false，
   *   恢复同一个会话时直接跳过（宿主本来就在这个会话上，无谓断一次 MCP / 工具）。
   *
   * 调用方负责排队（`switchExtensionHost` 的 `hostSwitch` 链 / `reload` 的那一条）。
   */
  const rebindHost = async (
    reason: 'new' | 'resume' | 'reload',
    force: boolean,
  ): Promise<boolean> => {
    if (disposed) return false;
    const targetId = current.sessionId;
    if (!force && hostSessionId === targetId) return true;
    const targetFile = current.recorder?.file;
    const previousFile = hostSessionFile;
    const previousHost = extensionHostRef;
    if (previousHost !== undefined) {
      try {
        await previousHost.shutdown({
          reason,
          ...(targetFile !== undefined ? { targetSessionFile: targetFile } : {}),
        });
      } catch (error) {
        hostErrors.push(`扩展收尾失败（${reason}）：${errorText(error)}`);
      }
    }
    if (disposed) return false;
    let nextHost: ExtensionHost;
    try {
      nextHost = await createExtensionHost();
    } catch (error) {
      // 旧宿主已经收掉了：扩展能力（工具执行 / MCP）在这一次之后退化，但对话照常。
      // 写进诊断，不要静默 —— 「扩展突然不见了」比一条报错难查得多。
      hostErrors.push(`扩展重新装载失败（${reason}）：${errorText(error)}`);
      return false;
    }
    if (disposed) {
      await nextHost.dispose();
      return false;
    }
    extensionHostRef = nextHost;
    hostSessionId = targetId;
    hostSessionFile = targetFile;
    try {
      await nextHost.startSession({
        reason,
        ...(previousFile !== undefined ? { previousSessionFile: previousFile } : {}),
      });
    } catch (error) {
      hostErrors.push(`扩展重新激活失败（${reason}）：${errorText(error)}`);
    }
    return true;
  };

  /**
   * 把「当前生效的资源」装进 state：skill 清单、prompt 模板、system prompt 与工具声明。
   *
   * 启动装载与 `/reload` 共用这一份 —— 两处各写一遍必然漂，而漂移的症状是「prompt 里
   * 说的工具 / skill 与实际能调的不一致」，只有账单看得见。
   *
   * 顺序：先收 `before_agent_start` 写的段（MCP 的 `mcp_servers`——它里面还会等 `direct`
   * 服务器最多 10 秒），再算「声明给模型」的工具集（激活集 ∩ 注册表），最后拼 prompt。
   *
   * @returns 装载诊断（skill / prompt 冲突与警告），给界面的 `/reload` 回执用。
   */
  const applyPromptResources = async (
    extensionHost: ExtensionHost,
  ): Promise<{ diagnostics: string[] }> => {
    // 收 `before_agent_start` 写的 prompt 段（MCP 的 `mcp_servers`）。
    // 它里面还会等 `direct` 服务器最多 10 秒（与 pi 一致）—— 等完了，它们的工具才注册完。
    const sectionPatches = await extensionHost.collectPromptSections();
    // **声明给模型**的工具在这一刻定下：激活集 ∩ 注册表，再跑一遍 `prepareLoadout`
    // （codemode 靠它把自己的描述换成「现在能调哪些工具」的清单）。
    const declared = declaredToolset(cwd);
    const declaredNames = new Set(declared.tools.map((tool) => tool.name));
    // Skill 清单：官方 `DefaultResourceLoader` 扫各个目录（`~/.pi/agent/skills`、
    // `<cwd>/.pi/skills`、cwd 与祖先的 `.agents/skills`、`~/.agents/skills`），
    // 目录发现与重名判定与 pi 逐字相同；再由 pi 的 `buildSystemPrompt` 拼进 `<skills>` 段
    // （走 prompt.init，所以会被落盘、被回放）。
    //
    // 加载**失败不能拖垮启动**：一个写坏 frontmatter 的 skill 不该让整个界面起不来
    // （loadSkillRegistry 已经把异常收成 diagnostics 了）。诊断进 state，由界面
    // 开场横幅 / `/reload` 回执显示（与 pi 的 `[Skill conflicts]` 同形）。
    const skillRegistry = await loadSkillRegistry({
      cwd,
      ...(options.skillPaths ? { paths: options.skillPaths } : {}),
    });
    // Prompt 模板：与 skill 同一条装载链（`DefaultResourceLoader`），所以 pi 包清单里
    // `pi.prompts` 声明的模板（比如 pi-subagents 的 `/council`）在这里也会出现。
    // 它们**不进** system prompt，只进状态给界面用（开场横幅 / 补全 / 回车展开）。
    const promptRegistry = await loadPromptRegistry({ cwd });
    // System prompt 由 **pi 的 buildSystemPrompt** 拼（工具规则 / AGENTS.md / cwd / skill）。
    // 我们只收集输入：工具的 snippet+guideline、AGENTS.md 上下文（每次现读 —— `/reload`
    // 就是靠这一条把改了上下文文件的事带进去的）、skill 清单。
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
      ...(Object.keys(sectionPatches).length > 0 ? { sections: sectionPatches } : {}),
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
    return { diagnostics: [...skillRegistry.diagnostics, ...promptRegistry.diagnostics] };
  };

  const assembleExtensions = async (): Promise<void> => {
    const extensionHost = await createExtensionHost();
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
    // `reason` 与 pi 一致：从一个**已有会话**启动是 `resume`，否则 `startup`（pi 的
    // `hasExistingSession` 也是 `messages.length > 0`，见上面 `startupSession` 的注释）。
    // 扩展拿它区分「新开」与「接着聊」，`pi-background-tasks` 还靠它认 reload 交接。
    await extensionHost.startSession({
      reason: startupSession?.hasMessages === true ? 'resume' : 'startup',
    });
    // 记住这一轮激活绑在哪个会话上 —— 切会话时据此判「要不要重装」（见 `switchExtensionHost`）。
    hostSessionId = current.sessionId;
    hostSessionFile = current.recorder?.file;
    await applyPromptResources(extensionHost);
    // 装载完成 = 环已经 idle：给状态类扩展一个 `agent_settled`（**只发事件，不记轨迹**）。
    //
    // 为什么要它：Orca 的 pane 状态靠 hook 推（`agent_end` → done），而 pi 那边是 Orca
    // 自己认进程（`--command pi` 是它的已知 agent）—— ela 不在那份名单里，只能靠 hook。
    // 启动后若一个事件都没有（`session_start` 会被 Orca 丢掉：它没有 providerSession），
    // 宿主就永远显示 loading。这条事件的语义是**真的**：装载完了、环是 idle、静了。
    extensionHost.emitLifecycle({ type: 'agent_settled' });
  };

  /**
   * `/reload`：重新读一遍 settings / 扩展 / skill / prompt 模板 / 上下文文件，把结果装回 state。
   *
   * 与 pi 的 `AgentSession.reload()` 同一个顺序：
   * 1. 旧激活 `session_shutdown{reason:'reload'}`（`pi-background-tasks` 在这个 reason 下
   *    会做 **handoff**：`--survive-reload` 的后台任务交接给新激活，而不是被杀掉）；
   * 2. 重装扩展（新实例）并发 `session_start{reason:'reload'}`（MCP 重读 `mcp.json`）；
   * 3. 重读 settings 影响的工具选择（`defaultTools` / shell 配置）、skill、prompt 模板、
   *    `SYSTEM.md` / `APPEND_SYSTEM.md` / `AGENTS.md`，重新拼 system prompt 与工具声明。
   *
   * **不是第二套代码**：重装走 `rebindHost('reload', force)`（与切会话同一条机器，只是
   * 不因「会话没变」跳过），重拼 prompt 走 `applyPromptResources()`（与启动装载同一份）。
   *
   * 与 pi 一样拒绝在环跑的时候重载：那一刻重装宿主会把正在等的工具 / 流交给一个已经
   * shutdown 的宿主。
   */
  const reloadKernel = (): Promise<KernelReloadReport> => {
    if (store.getState().phase !== 'idle') {
      return Promise.resolve({
        ok: false,
        message: '上一回合还没结束，等它跑完再重载',
        diagnostics: [],
      });
    }
    let report: KernelReloadReport = { ok: false, diagnostics: [] };
    const run = async (): Promise<void> => {
      await ready;
      if (disposed) {
        report = { ok: false, message: '内核正在退出，没有重载', diagnostics: [] };
        return;
      }
      // 加队之后环可能又跑起来了（用户在这一瞬发了消息）：进队前那次检查不算数。
      if (store.getState().phase !== 'idle') {
        report = { ok: false, message: '上一回合还没结束，等它跑完再重载', diagnostics: [] };
        return;
      }
      // 上一次重装失败留下的诊断不该赖着：`/reload` 是「重新读一遍」的动作，报告里
      // 只该有这一次装载的结果（扩展自身报的错在下一条 `currentHost().errors` 里）。
      hostErrors.length = 0;
      if (options.noExtensions !== true) {
        const swapped = await rebindHost('reload', true);
        if (!swapped) {
          report = {
            ok: false,
            message: '扩展重新装载失败（详见诊断）',
            diagnostics: [...hostErrors, ...currentHost().errors],
          };
          return;
        }
      }
      if (disposed) {
        report = { ok: false, message: '内核正在退出，没有重载', diagnostics: [] };
        return;
      }
      // `defaultTools` / shell 配置可能改了：重建内置工具实例并丢掉开关缓存
      // （与 pi 的 `_buildRuntime()` 同一个效果）。扩展工具由新宿主自己重扫。
      resetTools(cwd);
      const { diagnostics } = await applyPromptResources(currentHost());
      report = { ok: true, diagnostics: [...diagnostics, ...currentHost().errors] };
    };
    hostSwitch = hostSwitch.then(run, run).catch((error: unknown) => {
      report = { ok: false, message: `重载失败：${errorText(error)}`, diagnostics: [] };
    });
    return hostSwitch.then(() => report);
  };

  // 现场装满还是推到后台：见 `KernelOptions.deferExtensions` 与 `Kernel.ready`。
  //
  // `ready` 在上面就声明过了（`activeHost` / `switchExtensionHost` 等它），这里只赋值。
  if (options.deferExtensions === true) {
    ready = assembleExtensions().catch((error) => {
      // 这一档下**不抛**：界面已经在跑了（首帧画完了），抛出去没人接 —— 收成诊断，
      // 界面读 `extensions.errors` 时会看到（与「一个扩展装不上」同一个口径）。
      deferredErrors.push(`扩展装载失败（界面不带扩展继续）：${errorText(error)}`);
    });
  } else {
    await assembleExtensions();
    ready = Promise.resolve();
  }

  // 装载段落盘：**写进同一个轨迹文件的前两行**。有了它，回放时不必重装配工具、不必再问 provider
  // 「这个模型支持中途插 system 吗」。
  //
  // 时机与用户发出第一句话绑定：内核在这里**不**直接调它，而是盯住 `traceBegun` 翻转的那一刻
  // （见下面那个订阅）—— 「进来看一眼就退出」不该留下一个只有装载段、零条对话的文件。
  //
  // 走 delegator（同一个 sink）而不是另开文件：少一半文件。位置在几条 add 记录之后也没问题，
  // 回放是按 op 类型收集的，与行序无关。

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

  // 「会话已开始」的信号 → 写装载段。判据是 reducer 在第一条 `user.message` 里置上的
  // `state.traceBegun`，于是「什么时候算这段会话开始」只有一个定义，不依赖调用方记得调
  // writeInit（忘了就等于这次会话的 init 段永远缺失）。
  //
  // 必须绕一圈才能先于落盘器的 flush：落盘器与本订阅都是 store 订阅器，而它在前面注册 ——
  // 所以这里不靠订阅顺序，而是让 delegator 在「traceBegun 翻转」后放行，于是落盘器那一轮 flush
  // 先把装载节点的 add 写出去，init 记录补在后面一行（回放按 op 收集，与行序无关）。
  //
  // `restoreSession` 灌回的是**已经**有轨迹文件的历史：init 段在文件里，所以那里把 `wroteInit`
  // 直接置真。
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
     * **先查存在再 dispatch**：取不到那个 Model 对象就什么都不做 —— 那说明配置与当前目录对不上，
     * 此时「说要用某个模型、但没人知道它的能力」比拒绝更糟（底栏显示新名字，请求却带着清零的
     * 能力发出去）。
     *
     * 不换掉 `runtime.spec` / `runtime.model`：那是**初始**装配，`extensionModelRegistry()` /
     * `createRuntime()` 还指着它 —— 改了等于把历史也改掉，`/new` 之后回不到命令行给的模型。
     * effect 表每次请求现取（`resolveModel`），所以只换 state 就够。
     */
    setModel(
      provider: string,
      modelId: string,
      modelOptions?: { thinkingLevel?: string | undefined },
    ): boolean {
      const model = runtime.models.getModel(provider, modelId);
      if (!model) return false;
      // 换模型之后用哪一档：作用域条目写死的档位 → per-model 覆盖 → 全局默认 → **当前那一档**
      // （逐条照抄 pi 的 `_getThinkingLevelForModelSwitch`）。最后必须 clamp：换到只认 high/max
      // 的模型而手上是 medium 时，不夹就会发出模型不认的 reasoning 值。
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
      // 切到新会话 = 换一次扩展激活：`session_shutdown{reason:'new'}` → 重装宿主 →
      // `session_start{reason:'new'}`（与 pi 的 `AgentSessionRuntime.newSession()` 同一个顺序）。
      // 只再发一次 `session_start` 在 `pi-background-tasks` 上是协议违规（换身份而不先
      // shutdown 会报 `pi_bg_reload_owner_activation_conflict`，见 `switchExtensionHost`）。
      //
      // 不 await：`/new` 是同步入口（界面要立刻拿到新 id），而重装是异步的（jiti + MCP）。
      // 重装窗口里要真用宿主的地方（`beforeAgentStart` / `tool_call`）会先等 `hostSwitch`。
      void switchExtensionHost('new');
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
      // 轨迹树也要读回来：只读消息的话恢复后对话区有内容、而轨迹面板是空的（文件明明在盘上），
      // 那类症状特别有欺骗性。
      //
      // 读不到（旧会话、或当时开了 --no-trace）不是错误：发不带树的那条 action。
      const traceDir = options.traceDir;
      const tree =
        id !== '' && traceDir !== null
          ? await loadTrace(id, traceDir ? { cwd, dir: traceDir } : { cwd })
          : null;
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
      // 与 `/new` 对称：pi 恢复会话时也是「收掉旧激活 → 建新激活」
      // （`AgentSessionRuntime.switchSession()`），扩展靠这组事件把「现在是哪个会话」
      // 重新认一遍 —— `pi-background-tasks` 的所有权身份、状态栏、MCP 重读 `mcp.json`
      // 全挂在上面。恢复的是**同一个**会话时 `switchExtensionHost` 会跳过（宿主本来就在
      // 这个会话上，无谓重装只会把工具与 MCP 连接断一次）。
      //
      // 这里**要等**：`restoreSession` 本来就是异步的，恢复完返回时扩展应该已经就绪。
      await switchExtensionHost('resume');
      if (previous.sink?.close) void previous.sink.close();

      return { id, restored: messages.length };
    },
    restore(messages: Message[]): void {
      for (const message of messages) {
        store.dispatch({ type: 'session.restored', message } as AgentAction);
      }
    },
    reload: reloadKernel,
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
      // 正在进行的宿主重装先等它停：它看到 `disposed` 会停在半路（装载完的那份自己收掉）。
      await hostSwitch;
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
