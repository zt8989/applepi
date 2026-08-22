# ADR-0004: LLM Configuration Sources (settings.json + .env)

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` rounds 1–2 (Q1–Q11). Awaiting implement-confirmation.

## Context

The agent's LLM config (`pickModel()` in `apps/agent/main.ts`) is read entirely from `process.env` (`LLM_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, …) and throws when a key is missing. We want a file-based configuration: LLM settings in a JSON file, real API keys in a secret file, with a placeholder→secret resolution rule.

## Decisions

- **Config files live at `~/.applepi/`** (not under `sessions/`): `~/.applepi/settings.json` (LLM settings) and `~/.applepi/.env` (secrets). Both are **global**, shared across workspaces.
- **LLM settings are the only source (Q3=b)** — `process.env` is no longer consulted for provider/model/apiKey. Settings file is a single source of truth for the agent's LLM wiring.
- **Schema (Q2=a)** — `{ "provider": "openai", "model": "gpt-4o-mini", "apiKey": "OPENAI_API_KEY" }`. Missing file → fail fast: `loadSettings` throws immediately with a message pointing at the file (**Amendment 2026-08-19**: previously "missing → defaults"; settings.json is the single source of truth, so its absence is a misconfiguration, not a bootstrap case). Field-level defaults still apply to a *present* file with partial fields (provider `openai`, model `gpt-4o-mini`; anthropic defaults `claude-3-5-sonnet-latest`). **Amendment (2026-08-19)**: optional `baseURL` field overrides the API endpoint and is forwarded to the SDK provider factory as `baseURL` (e.g. for OpenAI-compatible gateways).
- **Api key reference resolution (Q1=a)** — the `apiKey` value is treated as a key name into the secret file: `realKey = dotenv[apiKey] ?? apiKey`. Default apiKey = provider's canonical env name (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`). Writing a real key directly in settings.json also works (the .env lookup simply misses).
- **Secret file parsed with `dotenv` (Q7=b)** — added as a dependency (core). Parsing uses `dotenv.parse` on the raw file content (pure, does **not** write into `process.env`).
- **Core-owned resolution primitives (Q4=a)** — core provides `loadSettings`, `loadDotenv`, `resolveApiKey` (and/or a one-shot `resolveLlmConfig`); the agent builds the provider instance (`openai(...)` / `anthropic(...)`) from the resolved data. Reusable by a future web UI.
- **`/config` reloads config (Q5=c)** — a slash command re-reads settings.json + .env and rebuilds the model. `/reload` keeps its current scope (extensions + system prompt) and does **not** touch the provider.
- **Fail fast (Q6=a)** — missing settings.json → `loadSettings` throws at startup, before the REPL (amended 2026-08-19, was: defaults). A present-but-unusable resolved apiKey (no secret, placeholder-only) → `resolveLlmConfig` throws with a message pointing at the two files. `/config` catches both cases and keeps the current model (Q10=a).

## Consequences

- One canonical config location (`~/.applepi/`); no more per-shell env juggling.
- Secrets live in `.env` (should be `chmod 600`); settings.json may hold only the key *name* by default.
- Backward incompatibility: `OPENAI_API_KEY=… pnpm dev` stops working (deliberate, Q3=b).
- `/config` gives live reconfiguration without restarting the REPL.
