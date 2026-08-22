# 10. LLM 配置

> [09 界面与服务端 ←](09-server-web-tui.md) · [索引](../architecture.md) · [11 仓库布局 →](11-repo-layout.md)

见 ADR-0004 + ADR-0014（multi-provider registry）+ ADR-0016（双层配置）完整决策。要点：

- `~/.applepi/settings.json` 是 **LLM 配置唯一来源**（不再读 process.env）：
  multi-provider registry `{ providers, general? }`（ADR-0014）。**无 `active` 字段**
  —— 每个 provider 的模型都可选。
- **ProviderConfig**：`{ displayName, protocol, baseURL?, apiKeyRef, models? }`；
  `protocol`（openai-completions / openai-responses / anthropic-messages）选 SDK 工厂。
  `BUILTIN_PROVIDERS` 是只读预设目录；settings.json 只存 enabled + custom provider。
- **general 块（ADR-0016）**：`{ model?, reasoningLevel?, permissionLevel? }` 为全局默认
  （仅「设置-通用设置」页写）；生效值 = `session.config` 覆盖 ?? `general` ?? 内置默认
  （`resolveSessionConfig` 级联，归 core）。
- `~/.applepi/.env` 存真实密钥（`dotenv` 解析）；`realKey = dotenv[apiKeyRef] ?? apiKeyRef`。
- 配置解析原语归核心（`loadSettings` / `loadDotenv` / `resolveApiKey` /
  `resolveLlmConfig` / `resolveSessionConfig` / `mergedProviders`），app 组装 provider 实例。
- `/config` 重新读配置并重建模型；provider 保存后 web 调 `invalidateModel()` 清缓存模型。