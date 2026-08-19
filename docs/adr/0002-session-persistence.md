# ADR-0002: Session Persistence (jsonl + Resume + Reload)

## Status

Accepted — 2026-08-19, decided via a 3-round `/grill-with-docs` interview (frontier Q1–Q18). Implemented as tickets T09–T14; `pnpm verify` all green.

## Context

The harness currently runs a single prompt and exits; there is no system-prompt builder, no `/reload`, and no persistence. We want multi-turn sessions that survive process restarts and are inspectable, with an append-only audit log that distinguishes **lifecycle events** (system-prompt build, skill load, reload) from **messages sent to the LLM**. Resume and session-listing must be **core capabilities** (CLI is one interface; a web UI will reuse the same core later).

## Decisions

### Storage layout & format
- One append-only jsonl file per session: `~/.applepi/sessions/<workspace>/<session_id>.jsonl`.
- `<workspace>` = a slug of the process cwd **absolute path** (e.g. `/Users/x/applepi` → `Users-x-applepi`), so different projects never collide.
- `<session_id>` = uuid v4, printed at start, reused to resume.
- **Single file, two line kinds** (no separate event/message files):
  - Event line: `{"kind":"event","ts":<ISO>,"session_id":...,"workspace":...,"type":"system_prompt|skill|reload","phase":"start"|"end","payload":{...}}`
  - Message line: `{"kind":"message","ts":<ISO>,"session_id":...,"workspace":...,"role":"system|user|assistant|tool","content":...}`
- File is **append-only**; existing lines are never rewritten.

### Event types (final set)
- `system_prompt` — emitted when the system prompt is (re)built. `payload: { sections: string[] }` (e.g. `["base","skills"]`); the full text is already persisted as a `role:"system"` message line, so the event carries only the section list.
- `skill` — emitted **per `skill_load` tool execution** (start/end). start `payload: { name, source: "content"|"path" }`; end `payload: { ok: boolean, error?: string }`.
- `reload` — emitted by `/reload`. `payload: { extensionsDiscovered: string[], reset: true }`.
- `tool_subagent` — **out of scope** (Q1). `mcp` event — **removed** with the mcp feature (Q11/Q18).

### The replay transform (read-only)
To build the array sent to the LLM:
1. Read all lines; keep only `kind:"message"` lines, in file order.
2. If any `reload` event exists, the rebuilt system prompt (the last `role:"system"` message line in the file) **replaces `message[0]`**; all earlier `system` message lines are dropped. Other messages keep their order.
3. The original jsonl is never mutated — the transform is applied only at read time.

This is exactly the stated rule: "如果包含 reload，reload 之后重建出的那条系统提示词会直接替换第一个消息"; the raw jsonl keeps the full history.

### SessionStore is core-owned
- New `src/core/session.ts` exporting a `SessionStore` class (workspace-scoped):
  - `create(sessionId?)` — open (or create) the jsonl for a session id under the current workspace.
  - `appendEvent(type, phase, payload)` — write one event line.
  - `appendMessage(role, content)` — write one message line.
  - `load()` — replay transform → `{ messages, sessionId, workspace }` message array (per the rule above).
  - `list()` — enumerate `~/.applepi/sessions/<workspace>/*.jsonl` for `/sessions`.
- `Harness` holds an optional `SessionStore`. The CLI REPL and the future web UI both drive `harness.resume(id)` / `harness.listSessions()` — persistence logic lives in core, not per-UI.

### System prompt = extension-contributed sections (Q10=c, Q16=a)
- `api.addSystemPromptContributor(fn)` where `fn(ctx) => string | Promise<string>`.
- At build time, the harness assembles `base` section + every registered contributor section, in registration order, into one `role:"system"` message.
- The agent registers the `base` section at startup (hardcoded `buildBaseSystemPrompt()`); the **skills** extension contributes its section by reading `session.scratch` (replacing the old `llm`-middleware injection).
- On `/reload` the contributors are re-registered naturally (full harness reset), so the prompt reflects current extensions.

### `/reload` = full harness reset, scratch + history preserved (Q14=a)
- `/reload` builds a **new Harness** instance, re-registers built-ins (`bash`, `str_replace_editor`), the denylist extension, and re-runs `loadExtensionsFromDir`.
- **Preserved across reset**: `session.scratch` (loaded skills / memory) and `session.history` (prior turns). The system prompt is rebuilt from the preserved scratch.
- Emits one `reload` event (start+end) plus a fresh `system_prompt` event pair.

### REPL & slash commands (Q2=b+c, Q8=b, Q9=a, Q17=a)
- The CLI runs a REPL reading one user turn per line (Enter submits; `/paste` or shell heredoc for multi-line; Ctrl-D or `/exit` quits).
- Core slash commands (must work for web later): `/reload`, `/resume <id>` (switch active session, append to its jsonl; `<id>` absent → new), `/new`, `/sessions`, `/help`, `/exit`.
- resume switches the **active session** to `<id>`; later turns append to `<id>`'s jsonl, and its most-recent system prompt becomes `message[0]` per the replay rule.

### MCP feature removed (Q11, Q18=a)
- Delete `src/extensions/mcp.ts`, `src/agent/extensions/mcp.ext.ts`, `src/agent/scripts/check-mcp.ts`, `src/extensions/test/mcp.mjs`.
- Remove `mcp` references from `src/extensions/index.ts`, `package.json` (`check-mcp`/`verify`), `CONTEXT.md`, and the design spec.
- System-prompt `mcp` section is gone; event type `mcp` is dropped.

## Consequences

- **Auditability**: the jsonl is both a replayable history and a timeline of lifecycle events (skill load timings, reloads), without touching the canonical message stream.
- **UI-agnostic**: because `SessionStore` and resume/list live in core, a web UI needs no re-implementation of persistence.
- **Read-only replay keeps the source of truth immutable** — debugging a bad reload only needs reading the file; the LLM-facing array is always a pure function of the file.
- **Cost of reload**: full harness reset is heavier than incremental, but it correctly drops deleted extensions and re-discovers new ones; scratch/history preservation keeps skills & memory intact.
- **Loss**: removing MCP narrows integration reach to what `bash` can do directly; revisit only if a real mcp-cli server list is needed (was Q11-b, deferred).
