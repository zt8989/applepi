# 05 — model 会话覆盖 + 动态默认 + 空模型强弹选择器

**What to build:** 模型选定成为会话级覆盖：写 `session.config.model`（经 `saveConfig`），**不再写全局 `lastUsedModel`**；`general.model` 仅由设置页配置。解析走 02 级联（`session.config.model ?? general.model ?? 第一个可用 provider 的第一个模型`）。新增空模型 UX：当 cascade 解析不出任何模型时，web **发送时强制弹出模型选择器、未选有效模型则不发送**，且每次发送都弹直到配好（不假装能聊）。`getModel` / `saveLastUsed` 等收敛，不再依赖 `lastUsedModel`。

**Blocked by:** 01 — SessionConfig 存储；02 — general + 级联；03 — composer chip 写路径基建

**Status:** ready-for-agent

- [ ] model 选定写 `session.config.model` 覆盖（`saveConfig`），非全局
- [ ] 解析走 02 级联；model 默认 = 动态「第一个可用 provider 的第一个模型」
- [ ] `getModel`/`saveLastUsed` 收敛（不再写 `lastUsedModel` 全局）
- [ ] 空模型 UX：cascade 无模型时 web 发送强制弹模型选择器、未选不发送、每次重弹
- [ ] 验证：每会话选模型持久化并恢复；删 provider → 默认重算；清空全部模型 → 发送被弹窗拦截
