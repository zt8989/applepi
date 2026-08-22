# 10: 文档同步 —— architecture / design-principles / README 对齐 ADR-0017

**What to build:** 把文档从「web 唯一界面」时代同步到 ADR-0017 现状（前例：4165cc5 为 ADR-0016 做过同样同步）。

**Blocked by:** 09（服务端 + TUI + 心跳全部落地，文档才谈得上对齐）。

**Status:** resolved

- [x] `docs/architecture.md`：状态头 + ADR 清单 0016→0017；§1 架构图改为「web/tui 双接入端 → 共享服务端 → bundle → extensions → core」+ 依赖段重写；§1.6 App 条目标注 tui 已实现；§3 装配主体由 app 改为服务端（含 todo/plan/goal/ask_user 工厂、`.harness/` 状态文件、expectsAnswer）；§9 标题「界面：Web（唯一）」重写为「界面与共享运行时服务端」（server/web 壳/TUI 三小节 + attach/心跳/线协议）；§9.4 trace「唯一界面」措辞更正；§11 布局加 `packages/server` / `apps/tui` / `scripts/`、验证清单加 server/tui；§13 待确认 #3 勾除
- [x] `docs/design-principles.md` P14：trace 措辞「web（唯一界面）」→「web 与 TUI」
- [x] `docs/README.md`：仓库布局改为 `server → bundle → extensions → core` 单向 + 接入端说明；「唯一界面」条目改为共享运行时服务端 + 双接入端描述
- [x] 全仓 grep 无残余「唯一界面」引用；文档与代码实现一致