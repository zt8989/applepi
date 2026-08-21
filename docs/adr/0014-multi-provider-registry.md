# ADR-0014: Multi-provider registry (supersedes ADR-0004 single-provider model)

- **Status**: Confirmed (2026-08-20, via /grill-with-docs — settings modal + model config feature)
- **Supersedes**: ADR-0004's single `{ provider, model, apiKey, baseURL? }` settings shape (the *file location* and secret-separation intent of ADR-0004 are preserved).
- **Re-scoped by ADR-0016 (2026-08-21)**: the `lastUsedModel` global-only single record (and Q13 "no per-session model variant") is superseded by a `general` block of global defaults + per-session overrides in `session.config`. The multi-provider registry, `protocol`-selects-factory, builtin presets, and no-in-code-migration principles all stand.

## Context

The web GUI needs a **Settings modal** whose 模型 (Models) page manages **multiple model providers** — built-in vendors (DeepSeek, OpenAI, Anthropic, Gemini, 智谱, 通义千问 …) plus **custom providers** (Provider ID + 显示名称 + API 地址 + API 协议 + API 密钥 + 模型目录). Each provider is independently keyed, base-URL'd, and carries its own **model catalog** (获取可用模型 / 添加模型). This directly collides with ADR-0004, which fixed LLM config to a *single* provider in one `settings.json`.

We must decide whether the multi-provider model lives in core (shared by CLI + web, ADR-0004's whole point) or is a web-only store (which would fork the two interfaces and break `/config` / `resolveLlmConfig`).

## Decision

1. **Multi-provider registry is the new core config.** `~/.applepi/settings.json` becomes:
   ```jsonc
   {
     "providers": {
       "<providerId>": {
         "displayName": "DeepSeek",
         "protocol": "openai-completions",   // openai-completions | openai-responses | anthropic-messages
         "baseURL": "https://...",           // optional
         "apiKeyRef": "PROVIDER_DEEPSEEK_API_KEY",
         "models": [{ "id": "deepseek-chat", "displayName": "DeepSeek Chat" }], // optional catalog
         "builtin": true                      // true for builtin presets, absent/undefined for user providers
       }
     },
     "lastUsedModel": { "providerId": "deepseek", "modelId": "deepseek-chat" } // global default
   }
   ```
2. **No `active` field.** Every provider's models are selectable. The system records the last-used model into `lastUsedModel` (global, single record — Q13) and pre-selects it in the model selector.
3. **`protocol` selects the SDK factory**; the legacy `provider` string is demoted to a display/grouping label. Mapping (single source of truth in `packages/core/config.ts`):
   - `openai-completions` → `createOpenAI({ apiKey, baseURL })` (chat completions)
   - `openai-responses` → `createOpenAI({ apiKey, baseURL })` (responses API)
   - `anthropic-messages` → `createAnthropic({ apiKey, baseURL })`
   - `ResolvedLlmConfig` gains a `protocol: string` field.
4. **Secret separation preserved (ADR-0004).** Each provider stores `apiKeyRef` (a name into `~/.applepi/.env`); the UI's paste-to-save flow writes the *real* key under `PROVIDER_<ID_UPPER>_API_KEY` and stores the ref. Real keys never sit in `settings.json`.
5. **Builtin presets are read-only** (`BUILTIN_PROVIDERS` in core); user-side `settings.json` holds enabled + custom providers only. Custom providers (`^[a-z][a-z0-9-]*$`, unique) are deletable; builtins are not.
6. **获取可用模型** works only for `openai-completions` / `openai-responses` (calls `{baseURL}/models`); disabled with a hint for `anthropic-messages` (no public list endpoint). An empty catalog still allows any typed model ID to send.
7. **Model cache coherency:** web's cached `modelPromise` is invalidated (`invalidateModel()`) after any provider save, mirroring CLI `/config`.
8. **No in-code migration.** Existing flat `settings.json` is migrated **once, manually** by the operator (see Migration below) — the code path does *not* retain backward-compat shims.

## Consequences

- CLI and web share one config shape and one `resolveLlmConfig` — no interface fork.
- `resolveLlmConfig` must resolve the *last-used* provider+model, not a single global provider.
- `apps/web/lib/server.ts#buildModel` switches on `protocol` instead of `provider === 'anthropic'`.
- The model selector UI is a provider-grouped two-level list pre-selected to `lastUsedModel`.

## Migration (one-time, operator-run — NOT in code)

For an existing flat `settings.json` (`{ provider, model, apiKey, baseURL? }`):
- Treat the old `provider` as a user provider with `providerId` = `openai`/`anthropic`/etc.
- `apiKeyRef` = the old `apiKey` value (kept as-is; `.env` is **not** copied — ADR-0004 ref semantics preserved).
- `protocol` derived: `anthropic` → `anthropic-messages`, everything else → `openai-completions`.
- `baseURL` copied verbatim.
- `lastUsedModel` = `{ providerId: <old provider>, modelId: <old model> }`.
