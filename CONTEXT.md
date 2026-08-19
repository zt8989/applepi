# CONTEXT.md

Project: a minimal **single-machine agent harness** (single pnpm package at the repo root).

## Glossary

- **Harness** — the minimal runtime: onion event bus + two built-in tools (`bash`, `str_replace_editor`) + loader + built-in agent loop.
- **Extension** — an in-process module that injects capabilities (tools, skills, memory, mcp) at runtime via `setup(api)`.
- **Hook / middleware** — lifecycle interceptors on three onion stacks: `session`, `llm`, `tool`. Can observe, veto (skip `next()`), or rewrite `ctx`.
- **Tool** — a capability registered via `api.registerTool({ name, description, parameters (zod), execute })`.
- **Denylist** — a privileged built-in extension, registered outermost on the `tool` stack, that vetoes banned `bash` commands.
- **MCP** — reached via `bash` + `mcp-cli`; no dedicated bridge.

## Key decisions (locked)

Full spec: `harness-design-spec.md`. Flat package layout (single package at the repo root):

- `src/core` — the harness runtime (onion bus, two built-in tools, loader, built-in loop)
- `src/extensions` — reference extensions: memory / skills / mcp
- `src/agent` — the local agent: `main.ts` wires core + extensions + a provider and runs the loop; `extensions/` holds local `*.ext.ts`; `scripts/` holds the key-free verification checks

Architecture decisions are recorded as ADR-0001.
