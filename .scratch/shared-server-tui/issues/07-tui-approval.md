# 07: TUI 批准闭环（y/n + ask_user 文本回答）

**What to build:** TUI 内完成工具批准全闭环：写类 `ask` 工具暂停后行内渲染 y/n 提示（批准 → 继续段；拒绝 → 回填「用户拒绝」）；ask_user 工具渲染文本输入行，回答经 approve-with-payload 回填为工具结果、对话无缝继续。批准请求状态与服务端 `tool/approval-pending` 事件一致（含 expectsAnswer 判定）。

**Blocked by:** 05（契约冻结点）。

**Status:** ready-for-agent

- [ ] ask 工具暂停 → 行内 y/n（键盘 y / n 或回车选择）；批准/拒绝后段续跑
- [ ] ask_user（expectsAnswer）→ 文本输入行；提交答案后结果=答案回填；拒绝 → 「未回答」回填
- [ ] 连续多 pending 时按序逐个处理
- [ ] 手工 E2E：写工具批准一次 + ask_user 问答一次（TUI 内完成，不离开终端）
- [ ] `pnpm -r verify` 绿