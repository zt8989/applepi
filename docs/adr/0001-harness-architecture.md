# ADR-0001: Minimal Harness Architecture

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-18, locked via a 16-round `/grill-me` interview.

## Context

We need a minimal **single-machine agent harness**. The core runtime must stay tiny; every incremental capability (memory, skills, mcp) arrives through extensions loaded at runtime.

## Decisions

- **Core runtime** = onion event bus + two built-in tools (`bash`, `str_replace_editor`) + loader + a built-in agent loop.
- **Extensions** are in-process modules, auto-discovered from a local `extensions/` directory, registered via `setup(api)` (pull mode). `api` exposes `ctx` for session state. Zero process isolation is accepted for a local agent.
- **Hooks** use an onion model over three stacks — `session`, `llm`, `tool`. Power level = observe + veto + rewrite (level iii).
- **Provider abstraction** via Vercel AI SDK; tool schemas use **zod** (not raw JSON Schema).
- **Denylist** = a privileged built-in extension, registered outermost on the `tool` stack and non-overridable. Because it is the outermost layer, it inspects the final (possibly rewritten) args — so the (b) command-filter security layer holds even under level-(iii) rewrite power.
- **MCP** is reached via `bash` + `mcp-cli`; no dedicated bridge is built.

## Consequences

- No process isolation: a misbehaving extension can crash the loop. Mitigated by per-layer `try/catch` soft isolation in the bus (tool stack converts throws to `ERROR` results).
- Trust boundary = the local machine / code the user chooses to run. Auto-discovery means "installed/placed locally = trusted".
- The onion model collapses the earlier discrete pre/post event tables into three middleware stacks.
