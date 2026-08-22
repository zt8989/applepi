# 07: TUI 批准闭环（y/n + ask_user 文本回答）

**What to build:** TUI 内完成工具批准全闭环：写类 `ask` 工具暂停后行内渲染 y/n 提示（批准 → 继续段；拒绝 → 回填「用户拒绝」）；ask_user 工具渲染文本输入行，回答经 approve-with-payload 回填为工具结果、对话无缝继续。批准请求状态与服务端 `tool/approval-pending` 事件一致（含 expectsAnswer 判定）。

**Blocked by:** 05（契约冻结点）。

**Status:** resolved

- [x] ask 工具暂停 → 行内 y/n（[y] 批准 / [n] 拒绝 / Ctrl-C 拒绝）；批准/拒绝后同一 turn 续流（结果折叠进工具卡片、pending 经 fold 清除）
- [x] ask_user（expectsAnswer）→ 文本回答行；回车提交答案（approve-with-payload，结果=答案）、空回车/Ctrl-C = 拒绝（「未回答」回填）
- [x] 连续多 pending 时按序逐个处理（每次 approve 流结束若仍有 pending 则重新进入决策提示）
- [x] 决策流与工具夹具的折叠/清除逻辑由解析器纯函数测试覆盖（fold: approval surface + expectsAnswer + resolution）；`pnpm -r verify` 绿
- 手工 E2E（真实终端 + 真实提供方）留待用户环境：自动化层已覆盖 决策状态机输入分支（tsc + 单测）与服务端 approve 往返（server chat-api）