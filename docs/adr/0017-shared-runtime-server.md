# ADR-0017: Shared Runtime Server + Web/TUI Clients

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。

> **修订注记（2026-08-22）**：core 实现文件 `stream-loop.ts` 已更名为 `loop.ts`（文件名与模块名对齐；正文沿用决策当时名称）。

## Status

Accepted — 2026-08-22, decided via `/grill-with-docs` (3 rounds). Design-recorded.

**Re-scopes the "web is the only interface" posture of ADR-0015 / the
`remove-cli-loop` cleanup**: the agent runtime backend, currently embedded in
`apps/web` (its API routes + `lib/server.ts`), moves into a standalone shared
process — the **Server** — and both `web` and `tui` become **clients**
(interfaces) that attach to it. `tui`, design-only since ADR-0015, is now
designed for implementation (Claude Code-style, via Ink).

## Context

ADR-0015 split core into deep modules and re-declared web/tui as orthogonal
interface apps, but kept only one interface alive: web, whose Next.js process
**both** serves the UI and owns the harness cache, session store bindings, and
all agent API routes. The CLI was deleted outright (`remove-cli-loop`).

Two needs converge:

1. **A terminal interface in the spirit of Claude Code.** The old CLI was
   REPL-only and was deleted; a Claude Code-style TUI (multi-line input,
   inline tool approval, streaming) is the natural second interface — it was
   modeled but never designed concretely.
2. **One runtime, not one runtime per interface.** If TUI and web each owned
   a backend, two running copies of the harness ecosystem would fight over
   `~/.applepi` state. The user's explicit model: starting either interface
   starts (or finds) **one** server; the other interface then attaches instead
   of starting a second backend.

## Decisions

### 1. The Server is a standalone process

New package `packages/server`: owns the per-(workspace, mode) Harness cache,
session/workspace/config operations (i.e. today's `apps/web/lib/server.ts`) and
all agent API routes (today's `apps/web/app/api/*`). HTTP via **Hono**, fixed
localhost port (default **3210**), bound to `127.0.0.1` only; no auth (same
trust model as the current web UI — personal single-machine tool).

### 2. Clients attach; first-starter spawns

`web` and `tui` are **clients**. A shared small helper implements
"probe → spawn → attach": probe `GET /api/health` on `127.0.0.1:3210`; if empty,
spawn the server detached (build-first `dist` entry, per repo convention), log
to `~/.applepi/server.log`; a port collision (two processes raced and both
spawned) self-heals via probe retry after EADDRINUSE. `APPLEPI_PORT` overrides
the default (test isolation).

### 3. Wire protocol is unchanged (AI SDK data-stream)

The streamed segment responses keep the existing data-stream line format
(`0:`/`2:`/`9:`/`d:` parts) that core's `stream-loop` already writes and web's
client already parses — zero change on both sides; TUI implements its own
parser of the same format. Interrupt semantics (Ctrl-C / client disconnect):
fetch abort → server aborts the current segment; no resume/undo in v1.

### 4. Web becomes a page shell

Next.js stays, serving pages only: all agent API routes move to the server;
`next.config` `rewrites()` proxies `/api/*` → `127.0.0.1:3210`, so the browser
stays same-origin, CORS is not needed, and web frontend code does not change.

### 5. TUI (Claude Code-style, v1 scope = core session loop)

Ink 5. Workspace = launch cwd (auto-registered in the manifest; `sessions`,
`resume`, `new` all scoped to it). Slash commands: the six core-builtins
(`/new` with `base|standard` arg, default standard, `/resume <id>`, `/sessions`,
`/config`, `/level`, `/help`) + `/exit`. Keys: Enter sends, Shift+Enter inserts
a newline. Inline tool approval (y/n) incl. ask_user free-text answer. Ctrl-C
interrupts the current segment. Explicitly out of v1: diff views, multi-pane,
session-management panels, workspace picker UI.

### 6. Lifecycle: heartbeat lease

The server counts attached clients' heartbeats and exits automatically when
none have been seen for 5 minutes; SIGINT exits immediately. A client exiting
is just a heartbeat going silent (running streams are aborted by disconnect).

### 7. Concurrency semantics: attach == hydrate

Opening a session re-fetches it fully (`GET /api/session`), as today; v1 has no
cross-client live push. Same-session concurrent use from both ends is the
user's own responsibility (personal single-machine tool).

### 8. Server test seam

Route-level tests via `fetch(app.request)` on the Hono app (real HTTP loop,
no browser); a `streamTextCall` injection seam inside the server for fake-LLM
tests (same style as core's stream-loop tests). TUI: protocol parser and
command mapping extracted as pure functions and unit-tested; Ink components
are not unit-tested.

## Consequences

- `apps/web` shrinks to pages + config/UI only; its `lib/server.ts` (≈700
  lines) and API routes move to `packages/server` mostly verbatim.
- Dependency graph becomes `server → bundle/extensions/core`, and
  `web → server` (via HTTP) with no direct core import in web (worth
  confirming during implementation; pages may retain pure display helpers).
- Root scripts: `pnpm serve` (server only), `pnpm dev` (web shell, ensures
  server), `pnpm tui` (TUI, ensures server).
- Tracked as: `.scratch/shared-server-tui/` (spec + tickets).