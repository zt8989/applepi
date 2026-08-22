# 03: ask_user 能力接线

**What to build:** 完整用户故事上线：standard 会话中模型信息不足时调用 ask_user 向用户提问 → 循环暂停、前端弹出**带文本输入框**的卡片（非二元按钮）→ 用户作答后续跑，答案作为该次工具结果回填；用户拒绝则回填明确的「用户未回答」反馈，模型自行调整。approval 强制 `ask`；capability 附 prompt 片段告知模型「关键决策信息不足时应主动提问而非猜测」。

**Blocked by:** 02（approve-with-payload 机制）。

**Status:** resolved

- [x] ask_user 以 Capability 契约注册进注册表（`ask-user.ts` + `CAPABILITIES` + `index.ts` 导出）；接线后该声明 id 不再打 warn（bundle 测试 8 改为断言 ask_user 不出现在 warn 中）
- [x] 工具 approval 强制为 `ask`（字符串形式，classifyApproval 在真实 harness 上验证 = ask），`expectsAnswer: true`；无读写副作用、不碰文件，任何权限级别可用；防御性 execute 返回 ERROR（正常路径不会被调用）
- [x] 装配缝断言：landed 列表含 ask_user、prompt 片段含问询引导且位于 capability 层；`Tools available` 含 ask_user；base bundle 不受影响
- [x] 机制级端到端（core 缝，无需真实 LLM/浏览器）：暂停 → part+事件带 expectsAnswer → 载荷续跑结果 = 答案、execute 未被调用、pending 清空；拒绝路径在既有测试中保持绿。**真实浏览器 + 真实提供方的卡片输入 E2E 留待用户环境验证（自动化缝已覆盖全链路逻辑）**
- [x] extensions（ask_user 10 项）+ bundle（9 项）测试全绿；`tsc` 全绿
