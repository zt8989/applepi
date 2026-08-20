# 设计原则（Design Principles）

> 从已锁定的设计决策（Q1–Q16 + ADR-0001~0012）中提炼的指导原则。
> 新增功能或修改架构时，应逐条对照；违反任何一条都需要走 grill 流程重新确认。

## P1. 极简核心（Minimal Core）

**核心运行时只保留骨架，不含任何具体能力。**

`@applepi/core` 仅包含：洋葱事件总线、加载器、内置 agent loop、会话存储、
LLM 配置解析。**不含工具**——`bash`、`str_replace_editor`、权限级别系统
（含 denylist 底线）全部在 `@applepi/extensions`（ADR-0005/0007）。

- 依据：Q5（极简落点）、ADR-0005。
- 后果：核心的消费方（如未来 web UI）不会被迫继承 shell 访问与安全策略。
- 判据：往 core 里加任何"有主见"的能力（一个工具、一条安全策略、一种后端），
  都是违反本原则的信号。

## P2. 能力全部经扩展注入（Capability Injection）

**一切增量能力（工具、skills、memory、安全层）都是 extension，运行时经
`setup(api)` 注入；核心不预知任何扩展的存在。**

- 依据：Q2（extension = 能力载体）。
- 后果：核心对能力无感知；扩展的注册顺序与组合决定最终行为。系统提示词
  段落（base 之外的 skills、权限声明）同样是扩展经各自块栈
  （`prompt/base` / `prompt/permission` / `prompt/skills`）注入的能力，核心只
  提供 PromptBag 机制与固定装配顺序、不含任何段落（ADR-0010）。
- 判据：新增能力时，先问"能不能做成扩展"，答案永远应该是"能"。

## P3. 洋葱模型（Onion Hooks）

**横切逻辑用中间件栈（session / llm / tool / prompt/base / prompt/permission /
prompt/skills）表达，观察、否决、改写三种权力内建于同一机制；priority 高 =
外层（先进入）。**

- 依据：Q15（洋葱模型取代离散事件表）、Q7（权力级别 iii）、ADR-0008
  （系统提示词构建成为栈）、ADR-0010（拆分为三个块栈，supersedes ADR-0008）。
- 后果：同一套 `Middleware` 签名覆盖全部横切场景；排序即权力（栈内）。
  系统提示词由三个 `prompt/*` 块栈构建：中间件用 `ctx.prompt.set(block, ...)`
  写入自己的块（PromptBag，只走 set），harness 按 base → permission → skills
  固定顺序拼装，sections 取构建期非空块列表（ADR-0010）。**洋葱栈 ≠ 事件
  发布**：`emit(event)` 是发布事件的入口（触发 core 内置处理器或写审计行），
  不是第 7 个栈——两者正交。
- 判据：需要新生命周期事件时，优先挂在既有栈上；**确有独立生命周期**
  （如提示词构建）才允许新增栈——新增栈是例外而非默认。

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
  级别只能由用户通过 `/level`（CLI）或权限胶囊（web）切换。
- 判据：不要用"挂一个特权中间件"或"放在核心/特权目录"来假装安全；安全必须
  体现在级别模型与工具自决上。

## P5. 单机信任模型（Local Trust）

**本地运行的代码 = 等价授信；安全层防的是模型犯错，不是防扩展。**

- 依据：Q1（单机 agent）、Q6（零进程隔离）、Q4/Q16（命令过滤）。
- 后果：零进程隔离，坏扩展能拖垮 loop——由总线软隔离（每层 `try/catch`、
  tool 栈异常转 `ERROR` 结果）兜底。
- 判据：为扩展增加"安装时授信"类机制前先三思——它防的威胁模型在本项目中
  不存在。

## P6. UI 无关的核心（UI-Agnostic Core）

**持久化、配置解析、slash 命令语义、流式 loop、工具批准、trace 埋点都是核心
能力；CLI 与 Web 只是核心的两个接口。**

- 依据：ADR-0002（SessionStore 归 core）、ADR-0004（配置解析归 core）、
  ADR-0011（流式 loop + 批准状态机归 core）、ADR-0012（Langfuse trace 埋点归 core）。
- 后果：Web 界面（`@applepi/web`）直接驱动 `runLoopStreamSegment` / `SessionStore` /
  `resolveLlmConfig` / `trace`，不重写业务逻辑；批准卡片、工作区选择器、会话动作只是
  core 能力的 HTTP 适配。**core 不清算任何 UI 概念**（「活跃会话高亮」「会话树」等
  属于 web 层，不在 core）。
- 判据：新功能若只能被 CLI 用、无法被其它界面复用，或反过来把 UI 概念塞进 core，
  都说明放错了层。

## P7. 不可变审计日志（Immutable, Append-Only Audit）

**会话记录 append-only；LLM 视角的消息数组永远是文件的只读纯函数。**

- 依据：ADR-0002（jsonl 单文件、事件/消息两行型、replay 只读变换）、
  ADR-0006（行结构精简：`type`+`phase` 合并为 `event` 字段、行内去掉
  `session_id`/`workspace` 冗余身份字段）、ADR-0008 演进（所有事件经
  `emit(event)` 单一入口发布，`appendEvent` 收敛为存储原语）。
- 后果：坏掉的 reload 只靠读文件即可诊断；原始记录永不因视图变换被改写。
  行结构精简只影响"行内携带什么信息"，不影响 append-only 属性——文件路径
  仍是会话身份的权威位置（ADR-0006 的取舍：行不再自包含）。
- 判据：任何"修改历史行"的需求都是红旗，应该用事件 + 视图变换解决。

## P8. 依赖单向（One-Way Dependency）

**agent → extensions → core，跨包只用包名 import；构建采用 build-first。**

- 依据：ADR-0003（Q3/Q4）。
- 后果：core 可以被独立消费；扩展只依赖核心契约；agent 只组装。
- 判据：core 反向依赖 extensions 或 extensions 反向依赖 agent，即违规。

## P9. 可替换的参考实现（Replaceable Reference）

**内置工具是参考实现（reference tool），不是核心承诺。**

`bashTool` / `strReplaceEditorTool` 由 `@applepi/extensions` 提供，是可替换的
默认能力；扩展可以注册同名工具覆盖行为（按洋葱/注册语义决定）。

- 依据：ADR-0005（Q2/Q6）、CONTEXT.md 术语表。
- 后果：能力集可组合、可裁剪；默认能力集由 `baseExtension` 一行还原。
- 判据：把参考工具当"神圣不可动"的 API 使用，就误解了它的定位。

## P10. 单一事实来源（Single Source of Truth）

**每类事实只有一个权威位置：决策在 ADR、术语在 CONTEXT.md、LLM 配置在
settings.json、会话记录在 jsonl。**

- 依据：ADR-0004（Q3=b：settings.json 唯一来源，process.env 不再读）。
- 后果：没有多份互相打架的文档/配置；改配置只需动一处。
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

**能力面用通用机制表达，不为单个场景开专用 API；具体行为用注册/处理器
注入，而不是把每个动作做成一个方法。**

- 依据：ADR-0008 及其演进——系统提示词贡献从专用 `addSystemPromptContributor`
  收敛为 `system_prompt` 洋葱栈（ADR-0008），再演进为三个 `prompt/*` 块栈 +
  PromptBag.set（ADR-0010）；事件发布从 `emitSystemPrompt()` / `appendEvent()`
  收敛为单一 `emit(event, payload)` 入口 + core 内置处理器（2026-08-19 讨论）。
- 后果：`HarnessApi` 表面小而稳定——registerTool / use /
  registerSlashCommand / emit，没有逐事件、逐能力的方法；新能力按「栈中间件 +
  事件处理器」两种原语表达。扩展面对统一契约，core 的处理器/中间件是内置
  事实而非 API 承诺。
- 判据：为某个具体事件或能力新增专用方法前先问「能不能用既有栈或 emit +
  处理器表达」；答案是"能"就应收敛——专用方法每多一个，通用机制就贬值一分。

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

## P14. 可观测性归核心，双端共享（Observability in Core）

**trace 埋点位于 core，而非每个界面各自埋；CLI 与 Web 自动获得同样的追踪。**

core 的 `trace.ts` 在每轮、每次 LLM 调用、每次工具执行处打点，目标 Langfuse
Cloud（未配置则 no-op）。界面只负责把 trace id 透传给前端展示，不负责采集。

- 依据：ADR-0012（round 2 将 Langfuse 从自建改为云端、并把埋点下沉到 core）。
- 后果：新增界面不必重新埋点；追踪维度（token usage、工具 span）由 core 统一定义。
- 判据：在 web / agent 层写 LLM 调用埋点，说明该埋点本应归 core。

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

---

*每条原则均对应一个或多个已锁定决策；标注（Q#）为 grill 轮次，ADR-XXXX 为决策记录。最后更新 2026-08-20，纳入 ADR-0011 / ADR-0012 对应的流式 loop、工具批准、双接口与可观测性。*
