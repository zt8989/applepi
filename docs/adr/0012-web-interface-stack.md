# ADR-0012: Web Interface — Next.js + assistant-ui + AI SDK useChat + Langfuse in Core

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-20, decided via `/grill-with-docs` (web interface design, rounds 1–3).

## Context

The harness (CONTEXT.md) promised "CLI is just one interface; a future web UI
reuses the same core." The web interface had to be chosen: framework, chat
UI, streaming transport, observability, and where the tracing lives. The
interview settled the full stack (Q1=a, Q3→Q9 cloud, Q4=b, Q5=a, Q6=a).

## Decisions

### Stack

- **Next.js App Router** (`apps/web`, `@applepi/web`, port 3000) — the
  assistant-ui / AI SDK / Langfuse first-class citizen.
- **assistant-ui 0.15 primitives** composed with Tailwind v4 (the version
  ships unstyled primitives; messages are rendered from an
  `ExternalStoreRuntime` adapter so the approval cards are fully controlled).
- **AI SDK v4 `useChat`-protocol streams** (`createDataStreamResponse` +
  `processDataStream`), driven by `runLoopStreamSegment` (ADR-0011).
- Sessions map 1:1 to the core `SessionStore` jsonl; the web adds a
  **workspace picker** (list existing `~/.applepi/sessions/` workspaces or add
  a path, persisted in localStorage; switching resumes the workspace's most
  recent session — Q10, Q13).
- Personal local tool: no auth, no multi-user.

### Observability lives in core, targets Langfuse Cloud (Q4=b, Q9)

- `packages/core/trace.ts` creates a Langfuse tracer from
  `~/.applepi/.env` (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` /
  `LANGFUSE_BASE_URL`, ADR-0004 convention); unconfigured = no-op.
- Both loops (`runLoop`, `runLoopStreamSegment`) emit **one trace per turn**
  (session-scoped), **one generation per LLM call** (with token usage), and
  **one span per tool execution** — the CLI and the web both benefit with no
  per-interface wiring.
- Not self-hosted: the user chose Langfuse Cloud and pre-configured keys
  (self-hosting was reversed in round 2; the NAS branch was dropped).

### Wire scope for the web server

`lib/server.ts` keeps one Harness per workspace (baseExtension + memory +
skills reference extensions), one provider model from `resolveLlmConfig()`
(ADR-0004, no process.env), and per-request `bindSession` (resume or create +
restore security). The agent's local `apps/agent/extensions/*.ext.ts` are not
loaded by the web (path/cwd coupling) — noted as a follow-up.

## Consequences

- Four route handlers: `POST /api/chat` (segment 1), `POST /api/chat/approve`
  (pause/resume), `GET /api/session` (hydration), `GET|POST /api/workspaces`.
- A refresh re-hydrates the conversation and re-surfaces an outstanding
  approval from the persisted `tool/approval-pending` event.
- Trace contents (prompts + tool I/O) leave the machine to Langfuse Cloud —
  acceptable for a personal tool; revisit if sensitive data is involved
  (migrate to self-hosted Langfuse).
- Next dev server needs write access to its `.next` cache; run it
  unsandboxed locally.
