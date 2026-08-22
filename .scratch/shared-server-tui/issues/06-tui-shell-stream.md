# 06: TUI 壳 + 流式读会话闭环

**What to build:** `apps/tui`（Ink 5）最小可跑：启动即经共享 attach 函数 ensure server，并把启动 cwd 注册进 manifest（工作区 = cwd）；底部输入区（Enter 发送、Shift+Enter 换行、空输入不发）+ 消息流区；自写 data-stream 线格式解析器（`0:` 文本 / `9:` tool-call / `2:` 数据 / `d:` done，半行/异常行容忍）渲染流式回复；`/exit` 退出。解析器与「cwd→manifest 注册」为纯函数单测。

**Blocked by:** 05（契约冻结点：web 回归 = API 稳定信号）。

**Status:** ready-for-agent

- [ ] `apps/tui` 建包（Ink 5，依赖 server 的 attach 函数）
- [ ] `pnpm tui`：ensure server → attach → 注册启动 cwd 到 manifest → 进入交互
- [ ] 输入区键位（Enter 发送 / Shift+Enter 换行 / 空不发）；消息流区流式渲染
- [ ] data-stream 解析器纯函数单测（各 part 类型、半行拼接、异常行容忍）
- [ ] `/exit` 退出；手工 E2E：`pnpm tui` 问一句 → 流式显示模型回复
- [ ] `pnpm -r verify` 绿