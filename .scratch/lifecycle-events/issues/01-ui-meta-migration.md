# 01: UI 元数据迁入旁挂 meta 文件（title/set、pin/set、notify/set 移出 jsonl）

**What to build:** 会话的展示元数据（标题、置顶、通知）不再写入 jsonl 事件行，改存到会话旁的 meta 文件（last-wins：`{ title?, pinned?, notify? }`，缺失视为无覆盖）；会话列表、标题、置顶、通知的对外行为与现状完全一致。jsonl 从这一步开始只保留消息行 + LM 过程事件。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 会话动作（重命名/置顶/取消置顶/通知开关）写 meta 文件而非 jsonl 事件
- [ ] 会话展示元数据读取原语语义不变（标题：最后写入的 title，否则首条用户消息截断；置顶/通知缺省 false），读取源切换为 meta 文件
- [ ] 会话列表输出（id/title/ts/pinned/notify，mtime 降序）与改造前一致
- [ ] jsonl 中不再出现 `title/set`、`pin/set`、`notify/set` 事件行；旧会话文件兼容（meta 缺失 = 无覆盖，行为与现状缺省一致）
- [ ] 相关 core/server 测试更新并通过，`pnpm -r verify` 全绿