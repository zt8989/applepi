# 03 — 推理等级并入 `session.config.reasoningLevel` + composer chip 写路径

**What to build:** 推理等级（reasoning level）从 `reasoning/set` 会话事件迁移到 `session.config.reasoningLevel` 覆盖值。composer 芯片切换只写会话覆盖（经 01 的 `saveConfig`），**不污染全局 `general`**；首条消息 pre-chosen 的 reasoning 写为初始覆盖。解析统一走 02 的级联：`session.config.reasoningLevel ?? general.reasoningLevel ?? medium`。web 的 `sessionReasoningLevel` / `saveLastUsedLevel` 等手写级联 adapter 收敛掉；`reasoning/set` 事件不再写入。

**Blocked by:** 01 — SessionConfig 存储；02 — general + 级联

**Status:** resolved —— 199d104（票面标注过期，实现已随对应提交落地，2026-08-22 审计修正）

- [ ] composer chip 切换写 `session.config.reasoningLevel`（`saveConfig`），仅覆盖、不改 `general`
- [ ] 首条消息 pre-chosen reasoning 写为初始覆盖
- [ ] 解析走 02 级联；web 旧级联（`sessionReasoningLevel`/`saveLastUsedLevel`）收敛
- [ ] `reasoning/set` 事件不再写入
- [ ] 验证：chip 切换 → 配置文件持久化并覆盖 general；新会话 pre-chosen 生效；未覆盖会话跟随 `general.reasoningLevel`
