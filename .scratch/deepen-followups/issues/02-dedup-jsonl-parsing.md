# 02 — 去重 SessionStore jsonl 解析管线（scanMeta / lastEvent / load）

**What to build:** `packages/core/session.ts` 中三处各自实现同一段 jsonl 读取管线：
`fs.readFile → raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))` ——
出现在 `load()`（188 行）、`lastEvent()`（228 行）、`scanMeta()`（261 行）。深深化 #02 的
票面承诺是「基于已有 `lastEvent` / 文件读取，不重复解析逻辑」，此处未完全兑现。

另外 `title()` / `pinned()` / `notify()` 各自调用一次 `scanMeta()`，每次都会重新读一遍
整个文件；会话列表（`listSessions`）对每个会话各扫一次。低频率展示路径可接受，但解析
管线本身值得收敛。

**建议做法：**
1. 抽一个私有 helper，例如 `private async readLines(id?)` 或 `private async scanLines(id?)`，
   统一「读文件 → 拆行 → 过滤空行 → JSON.parse（容忍坏行）」；`load` / `lastEvent` /
   `scanMeta` 都调用它。
2. 不改任何对外签名与返回形状（`title/pinned/notify/listSessions/lastEvent/load` 契约
   保持不变），只去重内部管线。
3. 顺带考虑给 `title/pinned/notify` 提供一次读取、同时解析三个元数据的能力 —— 目前
   `scanMeta` 已一次扫出三者，只是三个 public 方法各自触发一次全读；若调用方并发调用
   三者（如 web 列表渲染），可留意是否有必要合并（**取舍**：当前 web 只用 `listSessions`
   一次拿齐，`title/pinned/notify` 单点是低频路径，是否合并可留给实现时判断，不强制）。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 在 `SessionStore` 内新增私有 jsonl 读取 helper，替换 `load` / `lastEvent` / `scanMeta` 三处的重复管线。
- [x] 维持全部对外签名与返回形状不变；坏行容忍语义（`scanMeta` 跳行 / `load` 抛错 / `lastEvent` 无匹配返回 null）逐一保留。
- [x] `pnpm --filter @applepi/core test`（含 `session.mjs` 现有 15 项断言）全绿。
- [ ] 如做了 `title/pinned/notify` 合并读取优化，补充对应断言。（未做——按票面取舍保留单点低频路径，web 列表走 `listSessions` 单次拿齐。）

> 2026-08-22：由 deepen-architecture 5 票实现审查（.scratch/deepen-followups）发现的代码质量问题生成。
> 2026-08-22：完成。新增私有 `readLines()`（读文件 → 拆行 → trim → 滤空行），三处调用方各自保留原有
> 容错语义；未合并 `title/pinned/notify` 的多次读取（低频路径，票面明示不强制）。