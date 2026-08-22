# Spec: standard 能力包缺失能力补齐（todo / plan / goal / ask_user / web / subagent / workflow）

> 来源：/to-spec 综合 2026-08-22 对话（standard bundle 缺口盘点）。
> 状态：**ready-for-agent** —— 批次一（todo / plan / goal / ask_user）可直接实施；
> 批次二（web）、批次三（subagent / workflow）开工前需各做一轮 grill，已在 Out of Scope 标明。
> 测试缝：只用既有缝（装配缝 + core 流式 loop 缝），不新增。

## Problem Statement

standard 模式在产品语义上是「全量能力包」（工具 + 技能 + 记忆 + 规划/目标/子代理/工作流），但声明清单 9 个 capability 中只有 memory 和 skills 真正落地。用户选择 standard 模式后，实际得到的只是 bash、str_replace_editor、memory、skills——与 base 的实质差异远小于「标准 vs 极简」的承诺；规划、目标、子代理、工作流、联网等期望中的能力全部缺席。deepen #01 之后提示词已诚实化（不再声称未接线能力），缺口从「欺骗模型」变成了「功能欠账」：要么补齐实现，要么 standard 名不副实。

## Solution

按既有 Capability 契约为剩余 7 个 capability 各自提供真实实现，注册进 extensions 包的 capability 注册表。全部走 ADR-0015 已确立的装配路径（`enableBundleSpec` 注册工具、`assembleFlatPrompt` 追加片段），core 与 bundle 不动或仅微扩：

- **批次一（状态与交互类，先行）**：`todo`（任务清单）、`plan`（分步计划）、`goal`(会话目标)——三者均为 memory 形态（文件态 + 工具 + 每轮实时渲染的 prompt 片段）；`ask_user`（模型主动向用户提问并等待输入）——复用 ADR-0011 暂停/恢复状态机。
- **批次二（联网类）**：`web`——web_fetch / web_search 工具。
- **批次三（编排类）**：`subagent`（委派子任务给隔离子代理）、`workflow`（多步骤工作流）。

完成后 `STANDARD_CAPABILITIES` 声明的每个 id 都有工厂，未接线 warn 路径退化为纯防御；提示词诚实化机制（permissionFragment 由实际解析工具集生成）自动反映新增能力，无需任何逐 bundle 手写。

## User Stories

1. 作为 web 聊天用户，我在 standard 模式下让模型维护一份任务清单，模型用 todo 工具增删改条目，所以长任务的进度由模型自己跟踪而我不必复述。
2. 作为 web 聊天用户，我希望 todo 列表跨轮次持久并在会话恢复后仍在，所以中断后继续时进度不丢失。
3. 作为 web 聊天用户，我希望每轮对话的提示词里带上当前 todo 状态摘要，所以模型隔多轮也不会忘记还剩什么没做。
4. 作为 web 聊天用户，我让模型先给出分步计划再动手执行，模型用 plan 工具记录计划并随执行推进状态，所以复杂任务有可回看的过程。
5. 作为 web 聊天用户，我修改计划时只需自然语言说明，模型更新 plan 文件态，所以计划维护不增加我的操作负担。
6. 作为 web 聊天用户，我为会话设定一个目标，之后每轮提示词都提醒模型该目标，所以长对话不跑题。
7. 作为 web 聊天用户，我随时可以更改或清除会话目标，所以方向调整立即生效。
8. 作为 web 聊天用户，当模型信息不足时它通过 ask_user 向我提问而不是擅自猜测，所以我保留关键决策的控制权。
9. 作为 web 聊天用户，ask_user 的提问在前端呈现为带文本输入框的卡片，我输入答案后对话无缝继续，答案作为该次工具调用的结果回填给模型。
10. 作为 web 聊天用户，我对 ask_user 也可以拒绝回答（现有 deny 路径），模型收到明确的「用户未回答」反馈并可自行调整。
11. 作为 web 聊天用户，我让模型抓取某个 URL 的内容并基于它回答，web_fetch 工具把网页正文带回上下文，所以引用在线资料不需要我自己复制粘贴。
12. 作为 web 聊天用户，我让模型联网搜索以回答时效性问题，web_search 返回结果列表供模型进一步 fetch，所以模型的知识不再止于训练截止。
13. 作为 web 聊天用户，我把独立子任务委派出去（subagent），主对话不被中间过程污染，只有结论回到主线，所以上下文窗口留给主线任务。
14. 作为 web 聊天用户，我用 workflow 把一套固定多步骤流程交给模型按单执行，所以重复性流程每次执行一致。
15. 作为 web 聊天用户，无论权限级别是 readonly / workspace / fullaccess，所有新能力工具都遵循统一的级别语义（写类操作受 project root 约束），所以切换级别时行为可预期。
16. 作为 web 聊天用户，写类或有外部副作用的工具默认需要批准（ask），纯读类自动执行（auto），所以危险动作始终过一道用户确认。
17. 作为 web 聊天用户，base 模式完全不受本特性影响（sibling 隔离，无继承），所以极简模式的体验保持不变。
18. 作为开发者，我新增一个 capability 时只需往注册表加一个 adapter（id + prompt 片段 + tools），不改 core/bundle，所以能力扩展是低风险追加。
19. 作为开发者，ask_user 的暂停/续跑逻辑可在 core 侧用假 LLM 单测，不起真实模型、不开浏览器，所以回归验证快且稳定。
20. 作为维护者，提示词中「Tools available」清单由装配期实时生成，新能力接线后自动出现、无需同步文档串，所以提示词与注册面永不漂移。
21. 作为维护者，若有声明 id 因故缺失工厂，启动时仍打 warn 可见（现有行为保留为防御），所以半成品状态不会被静默吞掉。

## Implementation Decisions

- **一律 adapter 形态**：7 个能力都实现为 extensions 包的 `Capability`（`{ id, prompt(env, session), tools }`），注册进既有 `CAPABILITIES` 注册表；`STANDARD_CAPABILITIES` 声明顺序不变。bundle 包与 core 包零改动（唯一例外见 ask_user）。
- **批次一 · todo / plan / goal = memory 形态**：各自的会话态落盘在工作区内一个固定文件（清单/计划/目标各一），提供写工具（+ 必要的读工具），prompt 片段每轮实时读文件渲染当前状态——依赖扁平提示词「每轮重读同一份 spec」的性质，无重建事件。文件位置遵循 memory 的先例（project root 内），受权限级别约束。
- **批次一 · ask_user 复用暂停/恢复状态机**：ask_user 工具 approval 强制为 `ask`；到达即走现有暂停路径（持久化 pending 事件 + 流式 approval-pending part）。需要的唯一接口扩展：`executeApprovedTool` 的 approve 决定允许携带**载荷**（用户的答案文本），approve-with-payload 时工具结果 = 答案而非执行；deny 语义不变。前端批准卡片对 ask_user 渲染文本输入框而非二元按钮。
- **权限自决延续 ADR-0009**：每个新工具在 execute 内读 ctx 级别自决（写类受 project root 前缀检查约束；readonly 下 todo/plan/goal 写工具与 web/subagent/workflow 全部自拒）。approval 分类：todo/plan/goal 写工具与 web_fetch 默认 `ask` 还是 `auto` 在实施 grill 中定，倾向读 auto / 写 ask。
- **批次二 · web**：`web_fetch`（URL → 正文提取）+ `web_search`（查询 → 结果列表）。search 后端选型（外部搜索 API、密钥存放于 settings/.env 的哪个位）是该批开工前单独 grill 的议题；fetch 无外部依赖可先行。
- **批次三 · subagent / workflow**：subagent 预计复用 core 流式 loop 起子循环（审批嵌套策略、trace 层级、会话归属待 grill）；workflow 的形态（声明式清单 vs DSL）待 grill。两票不在本 spec 内定设计。
- **提示词诚实化机制不动**：permissionFragment 继续由 resolvedTools 实时生成；capability prompt 片段只在该能力真正接线后才会被拼入（注册表缺工厂即整段缺席），天然满足「不声称未接线能力」。

## Testing Decisions

- 好测试只测外部行为：断言「装配后的提示词包含什么、注册面有哪些工具、给定输入下工具返回/拦截什么」，不断言内部函数调用或文件布局细节。
- **缝 1（装配缝）**：`enableBundleSpec` + `assembleFlatPrompt`——每接一个能力断言 (a) warn 消失；(b) resolvedTools 含新工具名且去重稳定；(c) 对应 prompt 片段出现在正确层位（capability 层，位于 permissionFragment 之后、app/plugin 之前）；(d) base bundle 输出不受影响。先例：bundle 包现有测试（deepen #01 的 a–d 断言组）。
- **缝 2（core 流式 loop 缝）**：ask_user 的暂停/带载荷续跑用 `streamTextCall` 假体 + `onPending` 测试缝在 core 侧单测——假 LLM 发起 ask_user 调用 → 断言暂停与 pending 持久化 → 以 approve-with-payload 续跑 → 断言工具结果 = 答案文本、消息序列完整；deny 路径沿用现有断言风格。先例：core 现有 pause/resume 单测。
- **工具行为经 harness.executeTool + 级别 ctx**：todo/plan/goal/web 的权限自决在各扩展包测试覆盖（readonly 拒写、workspace 限 root、fullaccess 放行 + denylist 底线不受影响）。先例：extensions 现有 25 个工具测试。
- 前端不做组件内单测；tsc 全绿 + 手工 E2E 验证 ask_user 卡片输入答案后续跑。

## Out of Scope

- 批次二 search 后端与密钥位的最终设计、批次三 subagent 编排与 workflow 形态的最终设计——各自开工前单独 grill（届时产出增量决策记入 CONTEXT/ADR）。
- tui app（仅设计不实现的既定状态不变）。
- core loop / 审批机制的重构（本 spec 只做 approve-with-payload 这一处最小接口扩展）。
- 插件系统、base bundle、memory/skills 既有行为的任何变更。
- MCP 重引入（已删除的既定决策）。
- web UI 视觉重设计（ask_user 卡片沿用现有批准卡片壳，仅内容区换输入框）。

## Further Notes

- 与既有 ADR 关系：完全顺应 ADR-0015（capability 与 bundle 同构的声明式生产者）、ADR-0009（工具自决、core 无工具名特判）、ADR-0011(暂停/恢复状态机)；不推翻、不需修订任何 ADR。
- 本 spec 起源于 /improve-codebase-architecture 盘点中发现的「声明与实现漂移」；架构盘点本身（apps/web 服务端/客户端状态的深化候选）另行推进，与本特性互不阻塞。
- 实施建议用 /to-tickets 把批次一切成 tracer 票（每能力一张 + ask_user 接口扩展一张），批次二/三各留一张 grill 票占位。
