# ADR-0011: Streaming Loop + Tool Approval as a Pause/Resume State Machine

> **修订注记（2026-08-22）**：实现文件已更名为 `packages/core/loop.ts`（文件名与模块名 `loop` 对齐）；正文沿用决策当时名称。

## Status

Accepted — 2026-08-20, decided via `/grill-with-docs` (web interface design, rounds 1–3).

## Context

The harness had one interface (the CLI REPL) whose loop (`runLoop`, ADR-0005)
used `generateText` — a whole-turn, non-streaming LLM call — with the
interactive **permission level** model deciding tool behavior at execution
time. A second interface was needed: a web chat (Next.js + assistant-ui +
Vercel AI SDK `useChat`) with **token-level streaming** and **per-tool
approval in the browser** (Q8=c: the user chose a front-end approval UI over
the CLI's silent level model).

Two design constraints drove the shape:

- **No repeated LLM calls.** Resuming after an approval must not re-run the
  model turn that produced the tool call (cost, non-determinism).
- **Durability.** The approval decision must survive a browser refresh — the
  loop state must live in the session log, not in server memory.

## Decisions

### Streaming loop lives in core; CLI behavior unchanged (Q7=a, Q2=a)

A new `runLoopStreamSegment` (packages/core/stream-loop.ts) mirrors `runLoop`
but calls `streamText`, merges its parts into an AI SDK `DataStreamWriter`
(text deltas, tool-call parts, finish, usage), and executes tools through the
same onion `tool` stack. `runLoop` (generateText) is untouched — the CLI keeps
its exact semantics.

### Approval as a pause/resume state machine (Q11=a)

- A tool call classified **`ask`** pauses the segment: the pending approval
  (toolCallId / toolName / args) is persisted as a `tool/approval-pending`
  **session event**, an `approval-pending` data part is streamed, and the
  segment ends. The jsonl message log **is** the loop state — no server-side
  in-memory continuation.
- The client POSTs `/api/chat/approve` with the decision; the server replays
  the session, executes the approved tool (or feeds a refusal back), streams
  the tool-result part, then either pauses at the next pending call or
  continues the loop. **No LLM call is repeated** — the assistant message and
  its tool calls were already persisted.
- Each segment is a short-lived request; no long-lived connections.
- Stability of the UI message across segments is achieved by the **client
  owning the assistant message id** and echoing it (`messageId`) in every
  request; the server passes it to `experimental_generateMessageId` so all
  parts of one turn share one message.

### Approval classification is tool-declared (Q12=A)

- `ToolSpec.approval: 'auto' | 'ask' | (args) => mode`, default **`ask`**
  (conservative). Read-classified tools (`memory_read`, `skill_load`, `view`,
  bash readonly-whitelist commands) execute inline and stream their results;
  write/execute tools pause for approval.
- **Deny = tool result fed back to the model** (`[user denied] ...`), matching
  the CLI's blocked-tool error semantics — the model can self-correct.
- The CLI never consults `approval`; its interactive level model is unchanged.
  The web keeps the level model too: tools still self-determine against the
  permission level, so `workspace`/`readonly` scope rules apply even after a
  browser approval.

### Tool working root follows the selected workspace

Web sessions set `session.config.workspace`; core's `workspaceRoot(ctx)`
resolves it (falling back to the process cwd for the CLI). The reference
tools (bash, str_replace_editor) use it for `cwd` and for
`isInsideProjectRoot(rootOverride)` scope checks, and the Permission Level
prompt section displays it.

## Consequences

- Web interface = segmented streaming turns with per-tool approval cards,
  durable across refreshes; the CLI is unchanged.
- `runLoopStreamSegment` errors now **propagate** (the route's `onError` turns
  them into an error stream part) instead of silently truncating the stream.
- Known limits (accepted): `maxTurns` is capped per segment, not per turn;
  `ask`-classified tools still ask even when the level would have blocked them
  (the block surfaces after approval, as a `BLOCKED` result); per-command
  auto-approval for bash is a per-tool function, not a global policy.
