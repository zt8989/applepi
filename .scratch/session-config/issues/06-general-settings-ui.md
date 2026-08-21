# 06 — 设置-通用设置 UI（general 三默认编辑）

**What to build:** settings 弹窗新增「通用设置」区块，用于编辑全局默认 `general.model` / `general.reasoningLevel` / `general.permissionLevel`（**只写全局，不写会话**），持久化到 `settings.json.general`。改动后作用于所有未覆盖该 key 的会话（覆盖模式下 general 是运行时杠杆，不是创建时快照）。此为「设置-通用设置」界面的实现：全局默认的唯一编辑入口，与 chip/胶囊只写会话覆盖互补。

**Blocked by:** 02 — general + 级联；03 — reasoning 覆盖消费；04 — permission 覆盖消费

**Status:** ready-for-agent

- [ ] settings 弹窗出现「通用设置」区：model / reasoningLevel / permissionLevel 三默认
- [ ] 变更只写 `settings.json.general`（不写任何会话覆盖）
- [ ] 改后未覆盖会话跟随新全局默认、已覆盖会话保持覆盖
- [ ] 验证：设置页改全局默认 → 对应未覆盖会话行为变化
