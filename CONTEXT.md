# CONTEXT.md

Project: a minimal **single-machine agent harness** (single pnpm package at the repo root).

## Glossary

- **Harness** — the minimal runtime: onion event bus + two built-in tools (`bash`, `str_replace_editor`) + loader + built-in agent loop.
- **Extension** — an in-process module that injects capabilities (tools, skills, memory) at runtime via `setup(api)`.
- **Hook / middleware** — lifecycle interceptors on three onion stacks: `session`, `llm`, `tool`. Can observe, veto (skip `next()`), or rewrite `ctx`.
- **Tool** — a capability registered via `api.registerTool({ name, description, parameters (zod), execute })`.
- **Denylist** — a privileged built-in extension, registered outermost on the `tool` stack, that vetoes banned `bash` commands.

## Session persistence (glossary — decided via /grill-with-docs)

- **Session** — a persistent conversation bound to a `session_id`; recorded append-only to a jsonl file. The CLI runs a REPL; **resume & session-listing are core capabilities**, so a future web UI reuses the same core (CLI is just one interface).
- **Session id** — uuid (v4) generated per session, printed at start, reused to resume.
- **Workspace** — slug of the process cwd absolute path; the directory tier under `~/.applepi/sessions/<workspace>/`.
- **SessionStore** — a **core-owned** class managing the append-only jsonl for a workspace: `create`, `appendEvent`, `appendMessage`, `load` (replay → LLM message array), `list` (for `/sessions`). Lives in `src/core`, not the agent, so any UI can drive it.
- **Session store file** — single append-only jsonl at `~/.applepi/sessions/<workspace>/<session_id>.jsonl`. Each line is either an **event line** (`kind:"event"`) or a **message line** (`kind:"message"`).
- **Event** — `kind:"event"` line recording a lifecycle span with `phase:"start"|"end"`. Event types: `system_prompt`, `skill`, `reload`. (No `tool_subagent` — out of scope, Q1; `mcp` removed with the mcp feature, Q11.)
- **Message line** — `kind:"message"` line mirroring an LLM message (`role`: system|user|assistant|tool). The first system message is the system prompt.
- **Resume** — `/resume <id>` (core `SessionStore.load`) switches the active session to `<id>` and continues appending to its jsonl. `<id>` absent → new session.
- **Slash commands (core capability, not CLI-only)** — `/reload`, `/resume <id>`, `/new`, `/sessions` (list `~/.applepi/sessions/<workspace>/`), `/help`, `/exit`. A future web UI drives the same core methods.
- **REPL** — the CLI REPL reads one user turn per line (Enter submits); multi-line via `/paste` or shell heredoc. Ctrl-D / `/exit` quits.
- **Reload** — `/reload` slash command: full harness reset (new Harness, **preserving `session.scratch` + `session.history`**), re-register built-ins + denylist + `loadExtensionsFromDir`, then rebuild the system prompt; emits a `reload` event.
- **System-prompt contributor** — extensions register a section-builder via `api.addSystemPromptContributor(fn)`; the system prompt is assembled from base + all contributors (Q10=c). Supersedes the old `llm`-middleware skills injection. On reload the contributors are re-registered and the prompt rebuilt.
- **System prompt** — message[0]; composed of base instructions + loaded skills (via contributors). Rebuilt at session start and on `/reload`.
- **Replay transform (read-only)** — to build the LLM message array, filter the jsonl to message lines only. If a `reload` event exists, the most-recently rebuilt system message replaces message[0]; the original jsonl is never mutated.
- **MCP** — **feature removed** (Q11). Previously `mcp_call` via `bash`+`mcp-cli`; deleted from core/extensions/agent/docs.

## Key decisions (locked)

Full spec: `harness-design-spec.md`. Flat package layout (single package at the repo root):

- `src/core` — the harness runtime (onion bus, two built-in tools, loader, built-in loop)
- `src/extensions` — reference extensions: memory / skills (mcp removed, Q11)
- `src/agent` — the local agent: `main.ts` wires core + extensions + a provider and runs the loop; `extensions/` holds local `*.ext.ts`; `scripts/` holds the key-free verification checks

Architecture decisions are recorded as ADR-0001 (harness) and ADR-0002 (session persistence: jsonl + resume + reload).
