# 设计原则（Design Principles）

> 从已锁定的设计决策（Q1–Q16 + ADR-0001~0008）中提炼的指导原则。
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

## P4. 安全是最外层约定，不是位置特权（Convention over Mechanism）

**"最外层"是洋葱总线的注册约定（priority 1000），不是代码在哪个包里。**

安全扩展的安全性来自挂在 `tool` 栈最外层，在退出阶段审计内层改写后的
**最终参数**。denylist 从 core 移入 extensions、改写为纯中间件后，这一性质
不变（ADR-0005 Q3=A）；ADR-0007 将 denylist 演进为权限级别系统
（`readonly`/`workspace`/`fullaccess`），中间件仍挂 priority 1000，denylist
黑名单成为任何级别下都生效的绝对底线。

- 依据：Q16（修订）、ADR-0005、ADR-0007。
- 后果：组装扩展集的消费者**有责任**把权限中间件挂到 priority 1000；
  `baseExtension` 默认如此，自组装者自行承担。
- 判据：不要用"放在核心/特权目录"来假装安全；安全必须体现在挂载约定上。

## P5. 单机信任模型（Local Trust）

**本地运行的代码 = 等价授信；安全层防的是模型犯错，不是防扩展。**

- 依据：Q1（单机 agent）、Q6（零进程隔离）、Q4/Q16（命令过滤）。
- 后果：零进程隔离，坏扩展能拖垮 loop——由总线软隔离（每层 `try/catch`、
  tool 栈异常转 `ERROR` 结果）兜底。
- 判据：为扩展增加"安装时授信"类机制前先三思——它防的威胁模型在本项目中
  不存在。

## P6. UI 无关的核心（UI-Agnostic Core）

**持久化、配置解析、slash 命令语义是核心能力；CLI 只是核心的一个接口。**

- 依据：ADR-0002（SessionStore 归 core）、ADR-0004（配置解析原语归 core）。
- 后果：未来的 web UI 直接驱动 `harness.resume()` / `listSessions()` /
  `resolveLlmConfig()`，无需重写业务逻辑。
- 判据：新功能如果只能被 CLI 用、无法被其它界面复用，说明放错了层。

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

---

*每条原则均对应一个或多个已锁定决策；标注（Q#）为 grill 轮次，ADR-XXXX 为决策记录。*
