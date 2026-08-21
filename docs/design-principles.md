# 设计原则（Design Principles）

> 从已锁定的设计决策（Q1–Q16 + ADR-0001~0015）中提炼的指导原则。
> 新增功能或修改架构时，应逐条对照；违反任何一条都需要走 grill 流程重新确认。
> **2026-08-21 注**：ADR-0015（扁平 system_prompt + bundle/mode/app + core 深模块
> 拆分）已重塑 P1/P2/P3/P8/P12 并完成实现；洋葱/扩展注入机制已从 core 移除，
> 当前实现即为 ADR-0015 最终形态（见 architecture §1/§3/§4）。

## P1. 极简核心（Minimal Core）

**核心运行时只保留骨架，不含任何具体能力；core 的脊柱是「LLM 交互面」（system_prompt
+ tools），其余都是周边基础设施。**

ADR-0015 把 core 拆成单职责深模块：`llm`（LLM 交互面：工具目录 + 单段模型响应）、
`loop`（多回合编排）、`session`（持久化）、`config`（LLM 配置）、`security`（权限
强制）、`trace`（可观测），由薄 **Harness 壳** 组装。**不含工具**——`bash`、
`str_replace_editor`、skills、memory 全部在 `@applepi/extensions`（ADR-0005/0007），
能力集由 app/bundle 层装配。core 的 `llm` 只接受现成的 `{ prompt片段, tools }` 与
history 产出一段响应；`registerExtension`/洋葱这类通用能力注入机制**已移出 core**
（仅作为 app 层插件加载器/bundle 生产者形态残存）。

- 依据：Q5（极简落点）、ADR-0005；ADR-0015（core 只关心 system_prompt + tools）。
- 后果：核心的消费方（如 web UI）不会被迫继承 shell 访问与安全策略。
- 判据：往 core 里加任何"有主见"的能力（一个工具、一条安全策略、一种后端），
  或把能力装配逻辑（bundle/onion）塞进 core，都是违反本原则的信号。

## P2. 能力由 app/bundle 层装配，core 只收现成 spec（Capability Assembly Outside Core）

**一切具体能力（工具、skills、memory）都不进 core；能力集由 core 之外的
bundle/app 层装配，core 的 `llm` 只接受现成的 `{ prompt片段, tools }`。**

- 依据：ADR-0015（core 只关心 LLM 交互——system_prompt + tools）。
- 现状（已实现）：能力由 `packages/bundle`（`base`/`standard` 纯声明
  `(env)=>({prompt,tools})`）+ `@applepi/extensions` 能力工厂（memory/skills）+ app
  层插件加载器装配，core 不再持有通用能力注入机制（`registerExtension`/`HarnessApi`/
  洋葱已移除）。
- 后果：core 对能力无感知；会话在 app 里选一个 bundle（base 或 standard），叠加
  接口片段与插件，拼成 spec 交给 `llm`。系统提示词 = 扁平缓冲区
  `bundle 片段 → app 接口片段 → plugin 尾部片段` 顺序拼接（ADR-0015）。
- 判据：新增能力时，先问"能不能做成 bundle/扩展"，答案永远应该是"能"；把能力
  或装配逻辑写进 core 的 `llm`/`loop`，即放错了层。

## P3. 洋葱让位于扁平装配 + 单一职责循环（Onion Yields to Flat Assembly）

**横切逻辑从洋葱中间件栈收敛为「深模块 + 单一职责」：提示词用扁平片段顺序拼装，
多回合编排归 `loop`，模型调用归 `llm`。**

- 现状（已实现）：洋葱栈与 `prompt/*` 块栈已随 ADR-0015 移除（无会话/llm/tool
  洋葱、无 prompt 中间件、无 `PromptBag`、无洋葱排序协商）。
- 系统提示词是扁平装配：`bundle 片段 → app 接口片段 → plugin 尾部片段` 三层顺序
  拼接（下层不可改写上层），每轮重读同一份 spec；`loop`/`llm` 各自是深模块，
  `loop` 只编排多回合，`llm` 只经 `harness.llm.generate/stream` 取模型响应，
  工具经 `harness.executeTool`（工具执行缝）执行。
- 依据：ADR-0008/0010（历史洋葱）、ADR-0015（扁平 + 深模块，supersedes 前两者）。
- 后果：排序是结构性的、不需协商；新增横切能力优先落进对应深模块或 bundle，
  而不是再挂一个洋葱栈。
- 判据：需要新生命周期横切时，先问「属于 `llm` 还是 `loop`；或作为 bundle 片段
  注入」；**新增洋葱栈/`prompt/*` 块栈即违反 ADR-0015，应避免。**

## P4. 安全是级别模型 + 工具自决，不是特权中间件（Convention over Mechanism）

**安全由「级别模型 + 上下文注入 + 工具自决」表达，不是靠某个特权中间件或特权目录。**

ADR-0009 撤销了 priority-1000 的 permissionMiddleware（运行时闸口退场）：core 内置
SecurityPolicy 只保证两件事——① 级别模型（`readonly`/`workspace`/`fullaccess`）与
`level/set` 事件恢复；② 每个工具 execute 的 ctx 都携带当前 level。工具**自行**按
level 约束行为（bash 只读白名单、sre view-only、denylist 8 条危险正则内嵌 bash 自身
作为任何级别生效的底线）。「闸口」是**君子协定**（readonly 下不读 level 的工具仍全权），
core 不兜底——这是信任扩展边界的直接推论（P5）。

- 依据：Q12=a / Q16（撤销中间件）、ADR-0009。
- 后果：安全强度 = 每个工具的自决程度；模型没有任何改级别的工具（防自我提权），
  级别只能由用户通过权限胶囊（web）切换（core 的 `/level` 语义，原 CLI 命令已删）。
  强制机制（级别/ctx 注入/工具自决 + `/level`）在 core `security` 模块（工具执行缝）；
  权限**声明段**在 bundle（base/standard 各自声明贴合自身工具集、按级别分档的提示词
  片段，ADR-0015），core 不写提示词文案。
- 判据：不要用"挂一个特权中间件"或"放在核心/特权目录"来假装安全；安全必须
  体现在级别模型与工具自决上。

## P5. 单机信任模型（Local Trust）

**本地运行的代码 = 等价授信；安全层防的是模型犯错，不是防扩展。**

- 依据：Q1（单机 agent）、Q6（零进程隔离）、Q4/Q16（命令过滤）。
- 后果：零进程隔离，坏扩展/坏工具能抛错——由 `harness.executeTool` 的 try/catch
  把工具抛错兜成 `ERROR` 结果回填模型，不拖死整个 loop。
- 判据：为扩展增加"安装时授信"类机制前先三思——它防的威胁模型在本项目中
  不存在。

## P6. UI 无关的核心（UI-Agnostic Core）

**持久化、配置解析、slash 命令语义、流式 loop、工具批准、trace 埋点都是核心
能力；Web 是核心的（唯一）接口。**（CLI 已于 2026-08-21 删除。）

- 依据：ADR-0002（SessionStore 归 core）、ADR-0004（配置解析归 core）、
  ADR-0011（流式 loop + 批准状态机归 core）、ADR-0012（Langfuse trace 埋点归 core）。
- 后果：Web 界面（`@applepi/web`）直接驱动 `runLoopStreamSegment` / `SessionStore` /
  `resolveLlmConfig` / `trace`，不重写业务逻辑；批准卡片、工作区选择器、会话动作只是
  core 能力的 HTTP 适配。**core 不清算任何 UI 概念**（「活跃会话高亮」「会话树」等
  属于 web 层，不在 core）。
- 判据：新功能若无法被界面（web）复用，或反过来把 UI 概念塞进 core，都说明
  放错了层。

## P7. 不可变审计日志（Immutable, Append-Only Audit）

**会话记录 append-only；LLM 视角的消息数组永远是文件的只读纯函数。**

- 依据：ADR-0002（jsonl 单文件、事件/消息两行型、replay 只读变换）、
  ADR-0006（行结构精简：`type`+`phase` 合并为 `event` 字段、行内去掉
  `session_id`/`workspace` 冗余身份字段）。ADR-0015 移除 `emit` 事件总线和
  `system_prompt` 事件族后，事件（`level/set`、`reasoning/set`、`mode`、
  `reload/start|end` 等）由 app / 工具直接 `store.appendEvent` 写入 jsonl——
  `appendEvent` 是存储原语，不存在 core 内置事件处理器。
- 后果：坏掉的 reload 只靠读文件即可诊断；原始记录永不因视图变换被改写。
  行结构精简只影响"行内携带什么信息"，不影响 append-only 属性——文件路径
  仍是会话身份的权威位置（ADR-0006 的取舍：行不再自包含）。
- 判据：任何"修改历史行"的需求都是红旗，应该用事件 + 视图变换解决。

## P8. 依赖单向（One-Way Dependency）

**agent → bundle → extensions → core，跨包只用包名 import；构建采用 build-first。**

- 依据：ADR-0003（Q3/Q4）；ADR-0015（新增 `packages/bundle`，上游装配能力）。
- 后果：core 可以被独立消费；扩展只依赖核心契约；bundle/agent 只组装。
- 判据：core 反向依赖 extensions/bundle，或 extensions 反向依赖 agent，即违规。

## P9. 可替换的参考实现（Replaceable Reference）

**内置工具是参考实现（reference tool），不是核心承诺。**

`bashTool` / `strReplaceEditorTool` 由 `@applepi/extensions` 提供，是可替换的
默认能力；bundle（`base`/`standard`）引用这些共享工具实现，app 也可以替换注册。

- 依据：ADR-0005（Q2/Q6）、ADR-0015（`baseExtension` → `base` bundle）、CONTEXT.md 术语表。
- 后果：能力集可组合、可裁剪；默认能力集由 `base` / `standard` bundle 声明还原。
- 判据：把参考工具当"神圣不可动"的 API 使用，就误解了它的定位。

## P10. 单一事实来源（Single Source of Truth）

**每类事实只有一个权威位置：决策在 ADR、术语在 CONTEXT.md、LLM 配置在
settings.json、会话记录在 jsonl。**

- 依据：ADR-0004（Q3=b：settings.json 唯一来源，process.env 不再读）；ADR-0016
  将「单一事实来源」延伸到双层配置——全局默认只在 `settings.json.general`，
  会话覆盖只在 `<id>.config.json>`（`session.config`）。
- 后果：没有多份互相打架的文档/配置；改配置只需动一处；一个设置的生效值 =
  唯一的会话覆盖 ?? 唯一的全局默认 ?? 内置默认（cascade 单一公式，归 core）。
- 判据：发现同一事实被写了两遍（spec 重复 ADR、env 重复 settings），
  删除旧的那份——本 Wiki 的建立正是此原则的实例。

## P11. 配置失败要快（Fail Fast）

**配置不可用（密钥缺失、解析失败）在启动/`/config` 时立即报错并指向文件，
不静默降级。**

- 依据：ADR-0004（Q6=a）。
- 后果：环境问题在第一时间暴露，错误信息给出可操作路径
  （指向 settings.json / .env）。
- 判据：用缺省值掩盖配置错误，违反本原则。

## P12. 通用机制优先于专用方法（Generic over Bespoke）

**能力面用通用机制表达，不为单个场景开专用 API；具体行为用装配/声明注入，而不是把每个动作做成一个方法。**

系统提示词经历了收敛与再收敛：`addSystemPromptContributor` → `system_prompt`
洋葱栈（ADR-0008）→ 三个 `prompt/*` 块栈 + PromptBag（ADR-0010）→ **ADR-0015 扁平
spec**。每个 bundle 用**纯声明** `(env)=>({ prompt片段, tools })` 表达自身能力；
app 选 bundle、叠加接口片段与插件，拼成 spec 交给 core `llm`。**插件只能尾部追加**
（append-only），不能重排/删除 base/standard 内部——这是通用机制对"定制能力"的
边界。

- 后果：core 表面小而稳定；新能力 = 一个新 bundle/插件（声明 prompt 片段 +
  工具），而非给 core 或 Harness 加专用方法。`emit` 事件族已随洋葱一并移出 core
  （ADR-0015），提示词由 spec 驱动重建（每轮重读同一份 spec），无动态中间件。
- 判据：为某个具体能力新增专用方法/bundle 片段前先问「能不能用已有的 bundle/spec/
  声明表达」；答案是"能"就应收敛——专用方法每多一个，通用机制就贬值一分。

## P13. 循环状态即文件，批准不重跑 LLM（Durable Loop State）

**流式 loop 的暂停点是会话 jsonl 本身；批准后续跑从持久化点 resume，不重新调用 LLM。**

`runLoopStreamSegment` 在遇到 `ask` 工具时持久化 `tool/approval-pending` 事件并
暂停；`POST /api/chat/approve` 从 jsonl 的暂停点续跑。`jsonl` 既是审计日志
（P7）又是 loop 状态机——这是「文件即状态」的延伸：状态不需要额外的内存/数据库。

- 依据：ADR-0011。
- 后果：进程崩溃后可从 jsonl 恢复续跑；拒绝 = 工具结果回填模型（模型自愈），
  不需要回滚 jsonl。
- 判据：为 loop 新增「内存态」「续跑索引」等非文件状态前先三思——它破坏
  了「jsonl 是权威状态」的不变量。

## P14. 可观测性归核心（Observability in Core）

**trace 埋点位于 core，而非界面各自埋；web（唯一界面）自动获得追踪。**

core 的 `trace.ts` 在每轮、每次 LLM 调用、每次工具执行处打点，目标 Langfuse
Cloud（未配置则 no-op）。界面只负责把 trace id 透传给前端展示，不负责采集。

- 依据：ADR-0012（round 2 将 Langfuse 从自建改为云端、并把埋点下沉到 core）。
- 后果：界面不必重新埋点；追踪维度（token usage、工具 span）由 core 统一定义。
- 判据：在 web 层写 LLM 调用埋点，说明该埋点本应归 core。

## P15. UI 复刻要有显式产品增量（Faithful Replication, Explicit Deltas）

**复刻成熟 UI（如 assistant-ui base 壳）时，视觉 faithfully 跟随，但每个偏离
默认的产品决策都要显式记录、可追溯到 grill 结论。**

web 壳复刻 base 风格（两栏、外层圆角白卡、线性图标、中性色），但做了明确的产品
取舍：工作区选择胶囊**仅在新会话空态出现**、权限胶囊常驻、会话列表按工作区分组
树、不做建议 chips、placeholder 显式提示技能/指令——这些 delta 都来自
`/grill-with-docs` 的结论，写在 CONTEXT.md「Web UI shell」段。

- 依据：Web UI shell 设计轮次（Q1–Q12 + R3-Q1~Q4，2026-08-20）。
- 后果：reviewer 能区分「复刻了什么」和「改了什么、为什么改」，避免无意识偏离
  或重复讨论已决事项。
- 判据：UI 改动若找不到对应的 grill 结论或产品理由，应回到 grill 确认。

## P16. 文件引用走路径注入，而非内容注入（Reference by Path）

**`@引用文件`把文件路径作为结构化上下文注入 user 消息（「用户引用了以下文件：…」），
而不是把文件全文读进上下文。**

- 依据：Web 二期 F2 决策（2026-08-20）。
- 后果：大文件、二进制、目录都能被「引用」而不膨胀上下文；LLM 据此自行决定用
  Read/bash 读取哪些内容，工具基于 `workspaceRoot` 执行，相对路径即可解析。会话
  持久化时引用也作为 user 消息前缀留存，恢复后透明可见。
- 判据：能用「路径 + 让模型决定读取」解决的引用需求，不要用「全文拼接」——后者
  在大文件或批量引用时会迅速撑爆上下文窗口。

---

*每条原则均对应一个或多个已锁定决策；标注（Q#）为 grill 轮次，ADR-XXXX 为决策记录。最后更新 2026-08-21，纳入 ADR-0015（扁平 system_prompt + bundle/mode/app + core 深模块拆分）对 P1/P2/P3/P8/P12 的重塑，及 ADR-0016（统一会话配置 + 全局/会话双层配置）对 P10 的延伸；ADR-0011/0012 的流式 loop、工具批准、双接口与可观测性此前已纳入。*
