# 06: TUI 壳 + 流式读会话闭环

**What to build:** `apps/tui`（Ink 5）最小可跑：启动即经共享 attach 函数 ensure server，并把启动 cwd 注册进 manifest（工作区 = cwd）；底部输入区（Enter 发送、Shift+Enter 换行、空输入不发）+ 消息流区；自写 data-stream 线格式解析器（`0:` 文本 / `9:` tool-call / `2:` 数据 / `d:` done，半行/异常行容忍）渲染流式回复；`/exit` 退出。解析器与「cwd→manifest 注册」为纯函数单测。

**Blocked by:** 05（契约冻结点：web 回归 = API 稳定信号）。

**Status:** resolved

- [x] `apps/tui` 建包（ink 7 + react 19；依赖 server 的 attach 函数）
- [x] `pnpm tui`：build-first → ensure server → attach → 注册启动 cwd 到 manifest → Ink 交互（非 TTY 环境优雅降级为提示退出）
- [x] 输入区键位（Enter 发送 / Shift+Enter 换行 / 空不发 / Backspace）；消息流区流式渲染（文本 + 工具卡片）；Ctrl-C 中断当前段（fetch abort → 服务端停止），空闲时 Ctrl-C 退出
- [x] data-stream 解析器纯函数单测 5 项（六前缀分型、半行缓冲、CRLF、畸形行容忍、fold 会话/文本/批准面/结果清除）
- [x] 手工冒烟：非 TTY 下 attach 服务端成功、退出提示正确；`pnpm -r verify` 绿（21 套件 EXIT 0）