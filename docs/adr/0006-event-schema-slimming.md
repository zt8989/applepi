# ADR-0006: Slim the Session Line Schema

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-19, decided via a 2-round `/grill-with-docs` interview (Q1–Q9). Supersedes the line-schema parts of ADR-0002.

## Context

ADR-0002 defined each jsonl line as self-contained: every line carried `session_id` and `workspace` in addition to its payload, and events used a separate `type` + `phase` pair. A code audit showed the line-level fields are **write-only**: `SessionStore.load()` never reads a line's `session_id`/`workspace` (the session identity already lives in the file path `~/.applepi/sessions/<workspace>/<session_id>.jsonl`), and it never reads `payload`. The only functional consumption of an event line is the reload check, which needs nothing but "a reload happened".

We want a leaner schema without losing the audit timeline: keep every event, keep every payload, drop the redundant identity fields, and merge the event type + phase into one field.

## Decisions

### Line schema (replaces ADR-0002 §"Storage layout & format")
- Event line: `{"kind":"event","event":"system_prompt/start","payload":{...},"ts":<ISO>}`
- Message line: `{"kind":"message","role":"system|user|assistant|tool","content":...,"ts":<ISO>}`
- **Removed**: `session_id` and `workspace` from every line. Session/workspace identity is encoded in the file path; lines are no longer self-contained in isolation, only within their file.
- **Merged**: `type` + `phase` → single `event` field whose value embeds the phase: `system_prompt/start`, `system_prompt/end`, `skill/start`, `skill/end`, `reload/start`, `reload/end`.
- **Kept**: `kind` (discriminator between event and message lines), `ts` (explicit timestamp), `role` + `content` on message lines (functional dependency of `/resume` replay), and every payload.

### Event payloads (unchanged, one constant dropped)
- `system_prompt/*` → `{ sections: string[] }`
- `skill/start` → `{ name, source: "content"|"path"|"unknown" }`; `skill/end` → `{ ok, error? }`
- `reload/*` → `{ extensionsDiscovered: string[] }`. The former `reset: true` constant is **removed** (always true by definition of reload; redundant).

### Reload detection
- `load()` matches `l.kind === 'event' && l.event.startsWith('reload')` — the `?.` guard means pre-0006 lines (no `event` field) simply never match.
- No backward-compatibility reader for the old `type`/`phase`/`session_id`/`workspace` schema. Old files still resume fine (message lines are schema-compatible), but their reload semantics are lost — accepted, since this is pre-release.

## Consequences

- **Smaller lines**: every line drops two UUID/path fields; event lines drop one field.
- **Audit timeline intact**: event set and payloads unchanged, so the timeline story in ADR-0002 (§Consequences "Auditability") still holds.
- **Readability up**: `"event":"skill/start"` is more readable than `"type":"skill","phase":"start"`.
- **Self-containment dropped**: a line outside its file loses session context; mitigated by the file path carrying it.
- **Old sessions**: resume works, reload rule silently inert for pre-0006 files.
