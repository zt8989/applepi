# 02: TUI v1 —— Claude Code 风格核心会话闭环

**What to build:** 新 app `apps/tui`（Ink 5），`pnpm tui` = 探测→拉起→attach 服务端（复用票 01 的共享函数）。工作区 = 启动 cwd（自动注册 manifest）。核心会话体验：流式对话（自写 data-stream 线格式解析器渲染逐 token 文本与工具调用）、行内工具批准（y/n）、ask_user 文本回答（回答经 approve-with-payload 回填）、六个内置 slash 命令（`/new standard|base` 缺省 standard、`/resume <id>`、`/sessions`、`/config`、`/level`、`/help`）+ `/exit`；Enter 发送 / Shift+Enter 换行 / 空输入不发；Ctrl-C = fetch abort 中断当前段。协议解析与 slash 命令映射抽成纯函数并单测。

**Blocked by:** 01（服务端抽取 + web 壳）。

**Status:** ready-for-agent

- [ ] `apps/tui` 建包（Ink 5）：底部输入区（Enter 发送、Shift+Enter 换行）、消息流区、行内批准提示；`/exit` 退出
- [ ] 启动即 ensure server（共享 attach 函数）并注册启动 cwd 到 manifest；该工作区作用域内 `/sessions` / `/resume` / `/new` 可用
- [ ] 流式对话：自写 data-stream 解析器（`0:` 文本 / `9:` tool-call / `2:` 数据 / `d:` done），逐 token 渲染；Ctrl-C abort 当前段
- [ ] 工具批准：行内 y/n（写类 `ask` 工具）；ask_user 工具渲染文本输入行，答案回填后对话继续
- [ ] slash 命令映射为纯函数单测（六内置 + `/exit` + `/new` 的 mode 参数校验）；data-stream 解析器纯函数单测（含异常行/半行容忍）
- [ ] 手工 E2E：`pnpm tui` + `pnpm dev` 同跑，两侧 attach 同一服务端；TUI 全流程（对话/批准/ask_user/slash/中断）可用
- [ ] `pnpm -r verify` 绿