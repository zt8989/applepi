# 一次性迁移笔记：旧扁平 settings.json → ADR-0014 多提供方注册表（operator-run）

> ADR-0014 规定**工程代码不做迁移**，迁移由 operator 一次性手动执行。本笔记是 operator 参考，
> 记录「把旧 `provider` 识别成正确的内置厂商」的正确逻辑（避免把 DeepSeek 误识别成 openai）。

## 旧结构（ADR-0004 扁平）
```json
{ "provider": "openai", "baseURL": "https://api.deepseek.com", "apiKey": "OPENAI_API_KEY", "model": "deepseek-v4-flash" }
```

## 识别规则（关键）
旧配置的 `provider` 字段**不一定**是真实厂商——它常是「用 openai 兼容协议指向某厂商地址」的遗留。
正确识别方式：**用 `baseURL` 命中内置预设地址，归到对应的内置厂商**。

| baseURL（归一化后） | 真实厂商 |
|---|---|
| `https://api.deepseek.com` / `…/v1` | deepseek（内置预设，protocol=openai-completions） |
| `https://api.openai.com` / `…/v1` | openai |
| `https://api.anthropic.com` | anthropic |

- 命中内置预设 → 在 `settings.json.providers` 写入该 provider 的**用户启用条目**（含 `displayName`/`protocol`/
  `baseURL`/`apiKeyRef`），因为「用户启用了该厂商」就应在 settings 里可见可管理（providers 不应为空）。
  同时 `lastUsedModel` 指向它：`{ providerId: "<内置id>", modelId: "<旧 model>" }`。
- 未命中 → 作为用户提供方写入 `settings.providers`（id 取旧 provider 或推导）。

## .env key 迁移
旧 `apiKey` 是引用名（如 `OPENAI_API_KEY`）。若识别出的真实厂商是 deepseek，则把 `.env` 里
`OPENAI_API_KEY=<真实值>` **迁移**到 `PROVIDER_DEEPSEEK_API_KEY=<真实值>`，并删除原 `OPENAI_API_KEY` 行
（避免误导）。settings.json 里只存 `apiKeyRef`（派生名），不存真实 key。

## 本机已执行结果（2026-08-20）
- `settings.json`：
  ```json
  {
    "providers": {
      "deepseek": {
        "displayName": "DeepSeek",
        "protocol": "openai-completions",
        "baseURL": "https://api.deepseek.com/v1",
        "apiKeyRef": "PROVIDER_DEEPSEEK_API_KEY"
      }
    },
    "lastUsedModel": { "providerId": "deepseek", "modelId": "deepseek-v4-flash" }
  }
  ```
- `.env`：`PROVIDER_DEEPSEEK_API_KEY=sk-c2c7…`（原 OPENAI_API_KEY 的值已迁过来）
- 验证：`resolveLlmConfig()` 返回 `{ provider: "DeepSeek", protocol: "openai-completions", model: "deepseek-v4-flash", apiKey: "sk-c2c7…", baseURL: "https://api.deepseek.com/v1" }` ✅
- 前端 `getProviders` 合并 builtin ∪ user（user 优先），同名 deepseek 只渲染一次（在 user 表）。

## 坑
- `resolveLlmConfig` 必须合并 `BUILTIN_PROVIDERS`（用户表 ∪ 内置），否则纯用内置预设（settings.providers 为空）
  时会报 "no providers configured"。该合并逻辑已在 `packages/core/config.ts` 的 `resolveLlmConfig` 内实现。
