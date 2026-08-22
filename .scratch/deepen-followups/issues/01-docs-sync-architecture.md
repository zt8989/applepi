# 01 — 同步 architecture.md：ADR-0016 mode 配置化 + deepen #02/#03/#04 现状

**What to build:** `docs/architecture.md` 落后于实现，按当前代码事实同步（P10 单一事实来源精神：文档不能描述已废弃的机制）。主要两处：

1. `§9.3 工作区选择器与会话动作` 的 mode 持久化描述仍是旧的——「新会话在首条消息带上 `mode`，服务端记一次 `mode` 事件行；恢复时 `lastEvent('mode')` 重建匹配 spec」。**实现已按 ADR-0016 迁移**：mode 作为构建期身份写入 `<id>.config.json`（`apps/web/lib/server.ts` 的 `bindSession` → `store.saveConfig({ workspace, mode })`），恢复走 `Harness.resume`（`packages/core/harness.ts` 的 `this.session.config = await store.loadConfig()`）与 `sessionMode`（读 config 文件）。全库搜索确认已**无 `mode` 事件行写入**。另 `§9.3` 提到的「`applyPermissionLevel`（写 `level/set`）」也需按 ADR-0016 更新为「写 `session.config.permissionLevel` 覆盖」。

2. 补充 deepen #02/#03/#04 的现状记录：
   - `§8 会话持久化` 的 SessionStore 能力清单（`create / appendEvent / appendMessage / load / lastEvent / list`）补上 deepen #02 新增的 `title()` / `pinned()` / `notify()` / `listSessions()`（含 `SessionSummary` 返回形状与 mtime 排序）；
   - 补一段共享消息契约说明：`packages/core/message.ts`（`ThreadMessage` / `MessagePart` / `toText` / `mergeToolResults` / `pendingApproval`，纯 leaf 模块，web hydrate 消费，deepen #03）；
   - `§9` 或新小节记录 `apps/web/lib/display.ts`（纯展示逻辑，deepen #04）。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 核对 `docs/architecture.md` 当前文本，更新 §8/§9.3 两处落后描述。
- [x] 补充 deepen #02（SessionStore 语义化原语）、#03（共享消息契约）、#04（display 层）现状记录。
- [x] 交叉核对 CONTEXT.md 的对应段（ADR-0016 已同步），确保 architecture.md 与其一致、不重复打架。
- [x] 检查文档中其余沿用旧机制（如 `event` 行结构、`level/set` 事件）的表述，必要时加 ADR-0016 迁移注记。
- [x] 无需构建；纯文档改动，review 时确认无残留旧表述。

> 2026-08-22：由 deepen-architecture 5 票实现审查（.scratch/deepen-followups）发现的文档滞后项生成。
> 2026-08-22：完成。除 architecture.md 外，`docs/design-principles.md` P4/P7 的 `level/set` 残留与
> 「bundle 各自声明权限段」旧表述已同步为 ADR-0016 + deepen #01 现状；CONTEXT.md 两处
> 「另行实现」注记更新为已完成。