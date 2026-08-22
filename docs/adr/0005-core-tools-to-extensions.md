# ADR-0005: Move Reference Tools and the Denylist Out of Core into `baseExtension`

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` rounds 1–3 (Q1–Q7).

## Context

After ADR-0003 the workspace had three packages, but `@applepi/core` still owned the two concrete tools (`bash`, `str_replace_editor` in `packages/core/tools/`) and the denylist (`packages/core/extensions/denylist.ts`), re-exported from `core/index.ts`. All consumers (agent `main.ts`, six `check-*` scripts, and `core/test/smoke.mjs`) imported them from `@applepi/core`.

Two problems followed from this placement:

1. **Core was not actually minimal.** The spec (§0/Q5) claimed "核心保持极简", yet the core package shipped concrete, opinionated capabilities (shell access, file editing, a security policy). A future consumer of core (e.g. a web UI) would inherit tools and a security policy it may not want.
2. **"Privileged built-in" was a fiction.** The denylist's security property never came from living in core — it comes from being registered **outermost** (priority 1000) on the `tool` stack, where the onion's exit phase lets it audit the final command after inner rewrites. That is a registration convention of the onion bus, not a runtime guarantee of the package layout.

## Decisions

- **Core is purged of all concrete capabilities (Q1=A)** — `@applepi/core` now contains only: onion bus, loader, built-in loop, session store, and LLM-config resolution. It exports **no tools**.
- **Reference tools move to `@applepi/extensions` (Q2/Q6)** — `packages/extensions/tools/{bash,str_replace_editor}.ts`, exported as `bashTool` / `strReplaceEditorTool`. They are called **reference tools** in the glossary: replaceable reference implementations, not core.
- **The denylist becomes a pure middleware (Q7=A)** — `denylistExtension: SetupFn` is rewritten as `denylistMiddleware: Middleware` in `packages/extensions/denylist.ts`. Mounting priority is the caller's decision.
- **`baseExtension` (Q6)** — `packages/extensions/base.ts` exports a single `SetupFn` that registers `bashTool` + `strReplaceEditorTool` and mounts `denylistMiddleware` at priority 1000, outermost. One line (`harness.registerExtension(baseExtension)`) reproduces the old `main.ts` wiring. Since 2026-08-19 it also contributes the base system-prompt section (`BASE_SYSTEM_PROMPT`) on the `system_prompt` stack at priority 1000 (ADR-0008 Q3=a) — the agent's `main.ts` no longer owns any prompt text.
- **Privilege is a registration convention (Q3=A)** — the denylist's "privileged" status is now explicit: *whoever assembles an extension set must mount `denylistMiddleware` at priority 1000* to keep the closed loop. `baseExtension` does this by default; a consumer that assembles its own set inherits the responsibility. The security property itself is unchanged (the onion exit-phase audit still prevents inner rewrites from surfacing a real result).
- **Exports move** — `core/index.ts` drops the three symbols; `extensions/index.ts` exports `baseExtension`, `bashTool`, `strReplaceEditorTool`, `denylistMiddleware` alongside memory/skills. Seven consumers updated (`main.ts`, `check-soft-isolation`, `check-session`, `check-skills`, `check-memory`, `check-denylist`, `core/test/smoke.mjs`).
- **Tests split by ownership (Q5=A)** — `core/test/smoke.mjs` keeps bus/loop/loader tests (soft isolation exercised through a stub tool, not a reference tool); bash/str_replace/denylist coverage moves to `packages/extensions/test/{tools,denylist}.mjs`. Core tests never import `@applepi/extensions`.

## Consequences

- `@applepi/core` is a pure runtime skeleton — safe to consume without inheriting shell access or a security policy.
- The `extensions → core` dependency direction is preserved; nothing was added to core to make this work.
- The security property of the denylist is now documented as a convention instead of being implied by location. `check-denylist.ts` exercises the fine-grained path (manual `api.use('tool', denylistMiddleware, { priority: 1000 })`), and the four other checks exercise `baseExtension`, so both assembly styles are covered by the key-free test suite.
- Breaking change for any direct consumer of `@applepi/core`'s removed exports — acceptable at 0.0.x within a private workspace; all in-repo consumers were updated in the same change.
