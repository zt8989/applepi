# 02 — general 块 + 级联纯函数 `resolveSessionConfig` + model 动态默认

**What to build:** 全局/会话双层配置正式落地。`settings.json` 新增顶层 **`general` 块** `{ model?, reasoningLevel?, permissionLevel? }`（`loadSettings` 解析），顶层 `lastUsedModel` / `lastUsedLevel` **删除、无兼容读**。core `config` 模块提供统一级联纯函数 `resolveSessionConfig(sessionConfig?, general?)` → `{ model, reasoningLevel, permissionLevel }`，公式 = `会话覆盖 ?? general 默认 ?? 内置默认`（reasoning 缺省 → `medium`，permission → `workspace`）。model 的默认层是**读时计算、不存盘**的「第一个可用 provider 的第一个模型」（默认 model 所在 provider 被删 / 列表清空时自动改道，无修复回写路径）。`resolveLlmConfig` 收敛到同一 cascade，消灭原来按 `lastUsedModel` 独立解析的路径。

**Blocked by:** 01 — SessionConfig 类型 + `<id>.config.json>` 存储（共享 `SessionConfig` 类型）

**Status:** ready-for-agent

- [ ] `loadSettings` 解析 `general` 块；顶层 `lastUsedModel`/`lastUsedLevel` 不再产出（无兼容读）
- [ ] `resolveSessionConfig(sessionConfig?, general?)` 按 `覆盖 ?? general ?? builtin` 逐 key 级联：model / reasoningLevel / permissionLevel
- [ ] model 默认 = 读时计算的「第一个可用 provider 的第一个模型」，provider 删除/目录清空后自动改道
- [ ] `resolveLlmConfig` 收敛到同一 cascade（无独立 lastUsed 解析路径残留）
- [ ] core config 单测：无覆盖→general→builtin 逐层；general 缺 key 回落；provider 删除 → model 默认重算
