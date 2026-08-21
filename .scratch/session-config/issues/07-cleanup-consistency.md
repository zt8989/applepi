# 07 — 清理与一致性收尾

**What to build:** 三处覆盖收敛（reasoning / permission / model）之后的收尾清理：删除已死代码与路径——旧的 `reasoning/set`、`level/set`、`mode` 事件读写、`PERMISSION_SCRATCH_KEY` 残留、顶层 `lastUsedModel` / `lastUsedLevel` 解析、web 侧手写级联 adapter（`sessionReasoningLevel` 等）。确保全仓 grep 无被删符号残留、`pnpm -r verify` 全绿。（文档 CONTEXT.md / ADR-0016 / 设计原则已在设计期更新，无需本票再改，除非发现不一致。）

**Blocked by:** 03 — reasoning 覆盖；04 — permission 覆盖；05 — model 覆盖（三处收敛完成后才有可删的死代码）

**Status:** ready-for-agent

- [ ] 旧 `reasoning/set`/`level/set`/`mode` 事件读写及相关 adapter 删除
- [ ] `PERMISSION_SCRATCH_KEY` 残留、顶层 `lastUsedModel`/`lastUsedLevel` 解析删除
- [ ] 全仓 grep 无被删符号残留（node_modules / dist 除外）
- [ ] `pnpm -r verify` 全绿
