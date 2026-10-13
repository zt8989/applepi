/**
 * 内核 —— 整个应用**唯一**跑环的地方。
 *
 * 只有一个权威 Loop。界面层（`src/tui/`）只是它的渲染层：订阅 store、画状态、把输入 dispatch 回去。
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
import { createSessionRecorder, type SessionRecorder } from './session-recorder';
import { readSession, readSessionThinking, sessionMessages, sessionThinking } from './session-file';
import { findSessionFile } from './config-home';
import {
  clampForModel,
  isThinkingLevel,
  readDefaultThinkingLevel,
  readModelThinkingLevel,
  resolveStartupThinkingLevel,
  thinkingLevelForModelSwitch,
} from './thinking-level';
import path from 'node:path';
import { getTools } from './tools';
import { buildSystemPromptText, promptToolsFrom, type PromptToolLike } from './system-prompt';
import { loadExtensionHost } from './extension-host';
import type { HostUiOptions } from './extension-ui';
import type { ExtensionHost } from './extension-host';
import { loadSkillRegistry } from './skills';
/**
 * 从 Model 对象上读我们关心的三个能力。
 *
 * 位置不一样，所以分开取：
 *   - `supportsMidConvoSystemMessages` / `supportsMidConvoToolAdditions` 在 **BaseModel** 上（顶层）；
 *   - `supportsDeveloperRole` 在 **compat** 里，而且只有 openai 一族的 compat 有这个字段。
 *
 * 读不到就当 false（保守）—— 详见 reducer.ts 里 UNKNOWN_CAPABILITIES 的理由。
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
  /** 开一个新会话：换 id（于是换文件）、清空对话。**不会**把新消息写进旧文件。 */
  newSession(): { id: string };
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
   * ## 为什么是两条 action 而不是只一条
   *
   * `model.changed` 只改标识（provider / modelId），`model.init` 补上**能力与窗口**
   * （`supportsMidConvoSystemMessages` / `contextWindow`…）。能力是**模型之间不一样**的：
   * 一个支持中途插 system 的网关换成一个不支持的，还按旧的来会发出一份 provider 拒收的请求 ——
   * 而那种失败长得像「随机 400」，极难归因。所以两条都要发，且顺序是先 changed 后 init
   * （`model.changed` 把能力**保守地清掉**，`model.init` 才是权威，见 `reducer.ts`）。
   *
   * 思考级别**带着走**（从 state 读再传回去）：换模型不该顺手把 `high` 改成 `off`。
   *
   * 准确说：按 pi 的 `_getThinkingLevelForModelSwitch` **重新解析**一遍（作用域条目 /
   * per-model 覆盖 / 全局默认都排在「当前这一档」前面，最后 clamp 到新模型支持的那几档）——
   * 没配过 settings 时结果与「带着走」相同，配过时才分得出来（见实现里的注释）。
   *
   * @returns 换成功没有。找不���到那个模型就返回 `false` 并**不 dispatch** ——
   *   状态原封不动，比 dispatch 一次半换更安全。
   */
  setModel(
    provider: string,
    modelId: string,
    options?: { thinkingLevel?: string | undefined },
  ): boolean;
  /**
   * 扩展宿主（`settings.json` 的 `packages` 里装了什么）。
   *
   * 界面用它开场报一行「装了哪些扩展」，与 skill 清单同一个口径 —— 扩展也是
   * 「模型知道自己能做什么」的一部分，而 prompt 里那份用户看不见。
   */
  readonly extensions: ExtensionHost;
  dispose(): void;
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
export function defaultSystemPrompt(cwd: string = process.cwd()): string {
  return buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd), skills: loadSkillRegistry({ cwd }).skills });
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

  const { store, persistence, autoCompact } = createPersistentStore({
    runtime,
    // **不给** systemPrompt：真的那份由下面的 prompt.init 装（那时才需要 cwd、
    // 工具、skill）。这里给一个占位只会活到第一条 prompt.init。
    cwd,
    sessionId,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.maxLlmAttempts !== undefined ? { maxLlmAttempts: options.maxLlmAttempts } : {}),
    ...(options.traceDir === null ? {} : { traceSink: activeSink }),
    ...(options.onTraceError ? { onTraceError: options.onTraceError } : {}),
  });

  // ── 装载：prompt 与 model 各走一条 action 打进状态树 ──
  //
  // 为什么走 action 而不是直接写进 createInitialState：
  // 「装载」和「跑一轮对话」是同一类事（都是状态迁移），走 action 才能被落盘、被回放。
  // 回放时读到 init 段就知道当时发给模型的是什么，不必重装配工具、不必再问 provider 能力。
  //
  // 放在 store 建好之后：它们本身就是 dispatch，得走真实的 store。
  //
  // **扩展先装、工具清单后取** —— 顺序不能反。`getTools()` 是「官方工具 + 扩展工具」
  // 的合并结果，而 `prompt.init` 把那份清单装进 state（`effects.ts` 的 `toolSchemas()`
  // 原样读它发给模型）。先装扩展再取清单，模型才知道它有 `ask_user_question`；
  // 反过来它就只存在于注册表，症状是「工具调用永远回『未知工具』」，而界面上
  // 那个工具块连参数都画不出来。
  const extensionHost = await loadExtensionHost({
    store,
    cwd,
    // 扩展要自己调模型时靠这个拿凭证（`pi-web-access` 的答案/摘要）。主路径下
    // `runtime.runtime` 就是 pi 的 ModelRuntime（44 个内置 provider + 1500 模型），
    // extension-models.ts 把它包成扩展认的 ModelRegistry。
    ...(options.noExtensions ? {} : { runtime }),
    ...(options.uiOptions ? { uiOptions: options.uiOptions } : {}),
    ...(options.noExtensions ? { disabled: true } : {}),
    // 会话：扩展的 `getSessionId()` / `getBranch()`。传的是**取值函数**而不是常量 ——
    // `/new` 换会话后 id 会变，而扩展问的时候得报新的那个。
    sessionId: () => current.sessionId,
    // 扩展的 `pi.sendMessage` 落到哪里：一条**用户消息**（于是环会跑起来），
    // 与界面里敲一句话同一条路。
    onSendMessage: (text) => {
      if (text.trim() === '') return;
      store.dispatch({ type: 'user.message', text } as AgentAction);
    },
    canSend: () => store.getState().phase === 'idle',
  });
  const toolList = getTools(cwd);
  // Skill 清单：官方 `loadSkills()` + `loadSkillsFromDir()` 扫各个目录
  // （含跳工具约定的 `~/.agents/skills`），再由 reducer 拼进 system prompt
  // （走 prompt.init，所以会被落盘、被回放）。
  //
  // 加载**失败不能拖垮启动**：一个写坏 frontmatter 的 skill 不该让整个界面起不来
  // （loadSkillRegistry 已经把异常收成 diagnostics 了）。
  //
  // 诊断**不打到 stderr**：TUI 模式下 stderr 用户看不见，而「某个 skill 没加载上」
  // 正是静默退化（模型少了能力，界面与用户都不知道）。它们进 state，由界面开场显示
  // （与 pi 的 `[Skill conflicts]` 同形）。
  const skillRegistry = loadSkillRegistry({ cwd, ...(options.skillPaths ? { paths: options.skillPaths } : {}) });
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
  ];
  const systemPrompt = buildSystemPromptText({
    cwd,
    tools: promptTools,
    skills: skillRegistry.skills,
    ...(options.systemPrompt !== undefined ? { customPrompt: options.systemPrompt } : {}),
    ...(options.appendSystemPrompt !== undefined
      ? { appendPrompt: options.appendSystemPrompt }
      : {}),
  });
  store.dispatch({
    type: 'prompt.init',
    systemPrompt,
    tools: toolList.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    skills: skillRegistry.skills,
    skillDiagnostics: skillRegistry.diagnostics,
  });
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
    const records: InitRecord[] = [
      {
        op: 'prompt.init',
        // 落**拼好的那一整段**（不是 customPrompt 的原文）：回放时要能重建
        // 「当时发给模型的到底是什么」，而 AGENTS.md 与 skill 清单都可能已经变了。
        systemPrompt,
        tools: store.getState().prompt.tools,
        // skills 一并落：回放时要知道当时有哪些 skill（它们拼进了 prompt）。
        ...(skillRegistry.skills.length > 0 ? { skills: skillRegistry.skills } : {}),
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
  // 会话记录器：把消息流写成 `sessions/<cwd>/<时间戳>_<id>.jsonl`，供「恢复历史」用。
  // 它同样是 store 订阅器 —— 挂在 dispatch 链上，成功失败都记。
  //
  // 写成可替换的：`newSession()` 要换 id（于是换文件），而 store 不重建。
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

  return {
    store,
    runtime,
    /** 当前会话 id。**会变**（`newSession()` / 恢复历史），所以是取值而不是常量。 */
    get sessionId(): string {
      return current.sessionId;
    },
    persistence,
    /** 当前会话记录器（换会话后指向新的那个）。 */
    get session(): SessionRecorder | null {
      return current.recorder;
    },
    /**
     * 换模型：`model.changed`（改标识）+ `model.init`（补能力与窗口）。
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
      store.dispatch({ type: 'model.changed', provider, modelId } as AgentAction);
      store.dispatch({
        type: 'model.init',
        provider,
        modelId,
        thinkingLevel,
        reasoning: model.reasoning ?? false,
        capabilities: readCapabilities(model),
        contextWindow: model.contextWindow ?? 0,
      } as AgentAction);
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
    extensions: extensionHost,
    dispose(): void {
      unsubscribeStart();
      autoCompact?.dispose();
      current.recorder?.dispose();
      persistence?.dispose();
      if (current.sink?.close) void current.sink.close();
      extensionHost.dispose();
    },
  };
}
