# ADR-0007: Permission Levels — Read/Write Scoped Tool Access

## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` rounds 1–4 (Q1–Q16).

## Context

`denylistMiddleware` (ADR-0005) was a single pure middleware: eight regexes
against `bash` commands, mounted outermost (priority 1000). It answered one
question — *"is this command absolutely dangerous?"* — but had no notion of
**scope**. A model running the harness could `write` to any path on the machine
(`str_replace_editor` has no path restriction), run any non-denylisted command,
and persist memory anywhere. For a single-machine agent that shares the host
with the user's files, that is wider authority than most sessions need.

The user asked to evolve the denylist into a **read/write permission-level
system** (`readonly` / `workspace` / `fullaccess`) that does two things the
denylist never did: (1) **scopes tool behavior** by level, and (2) **rewrites
the system prompt** so the model *sees* its permission boundary instead of
discovering it by hitting blocks.

## Decisions

- **Levels are a read × write matrix (Q1/Q5)** — every level is defined by
  「可读范围 × 可写范围（修改粒度）」. Read scope is **always full-disk**;
  only write scope varies. `readonly` = read anywhere, write nowhere;
  `workspace` = read anywhere, write only inside **project root**;
  `fullaccess` = read/write anywhere, still bound by the denylist floor.
  There is no fourth level — 「修改级别」 is the *write-scope dimension*, not
  a separate tier.
- **One level per session, uniform across tools (Q2)** — no per-tool levels.
  The current level lives in `session.scratch['__permissionLevel']` and is
  read by every middleware/filter that needs it.
- **Level is persisted as a `level/set` event (Q3/Q11)** —
  `{"kind":"event","event":"level/set","payload":{"level":"workspace"},"ts":"..."}`
  appended to the session jsonl (ADR-0006 line shape; atomic, no start/end
  phase). On start and `/resume`, the current level = the **last** `level/set`
  event's `payload.level`, falling back to `workspace`. `SessionStore` gains
  `lastEvent(name): SessionEvent | null` — storage primitives stay in core
  (P6), level semantics stay in the permission extension.
- **Denylist survives as the absolute floor (Q4)** — the eight dangerous
  regexes (`rm -rf`, fork bomb, `mkfs.`, `dd if=`, `> /dev/sd`, `chmod -R 000 /`,
  etc.) are embedded inside `permissionMiddleware` and fire at **every level**,
  including `fullaccess`. Level governs scope & write permission; denylist
  governs absolute danger; they are orthogonal.
- **Double layer: registration-time filtering + runtime interception (Q10=c)** —
  (a) **Registration-time**: `HarnessApi.registerToolFilter(fn)` lets extensions
  **crop what the model sees** in `buildToolDefs()`. Signature
  `(toolName, def) => def | null`; filters compose in registration order; `null`
  hides the tool; a new def rewrites its description/parameters (e.g. readonly
  crops `str_replace_editor`'s parameter enum to `['view']`). Core stays
  permission-agnostic — it only applies registered filters (P1/P2).
  (b) **Runtime**: `permissionMiddleware` still mounts at priority 1000 and
  audits the **final** args after inner rewrites (two-stage ENTRY/EXIT, the
  ADR-0005 convention), so even a mis-cropped or rewritten call cannot surface
  a real result.
- **System prompt carries the level (Q9; mechanism superseded by ADR-0008)** —
  the permission extension contributes a fixed-structure「权限声明」section:
  level name, what that level allows/forbids, project root path, and the
  level-cropped tool list. Originally a system-prompt contributor
  (Q10=c); since ADR-0008 it is a `system_prompt`-stack middleware that
  pushes the section + `permission` label. The prompt is rebuilt on session
  start, `/resume`, and immediately after every `/level` switch (via
  `emit('system_prompt')`, the single event-publish entry; its newest system
  message replaces `message[0]` on replay — ADR-0002). Other prompt sections
  (base, skills) are unaffected (Q15).
- **Only the user can change the level (Q7)** — `/level <readonly|workspace|fullaccess>`
  is a **user-driven** slash command; the model has **no tool** to change
  levels (no self-privilege-escalation). The command writes `level/set`,
  updates `session.scratch`, and rebuilds the prompt.
- **Slash commands become a core extension point (Q13=a)** —
  `HarnessApi.registerSlashCommand(name, handler)` — a generic map + lookup;
  `main.ts` dispatches to extension-registered commands before built-ins.
  Mechanism only, no permission semantics (P1/P2); slash semantics belong to
  core (P6) so a future web UI reuses them.
- **Project root is the cwd realpath (Q6)** — in permission context,
  「工作区」 = `realpath(process.cwd())`, termed **project root** (distinct
  from the session *workspace* slug). Write targets are `realpath`-resolved
  (symbolic links resolved) then prefix-checked against project root;
  `..` escapes are naturally covered. Bash write detection is heuristic
  (`rm/mv/cp/mkdir/touch/tee/sed -i/redirects > >>`, etc.) with path
  extraction; **commands whose write target cannot be identified are blocked**
  — conservative by default (fail-closed).
- **Tool mapping by level (Q8/Q15)** — `bash`: readonly = read-only command
  whitelist (`ls cat grep pwd head tail wc find stat du echo`), everything else
  blocked; workspace = non-whitelist commands judged by the Q6 path rule.
  `str_replace_editor`: readonly only `view`; workspace `view/write/str_replace`
  with paths inside project root; fullaccess all. `memory_write` = write
  (blocked at readonly; allowed at workspace because its fixed target
  `harness-memory.json` lives in project root); `memory_read`/`skill_load` =
  read (allowed at every level). Classification is **by tool name**, not by
  path parsing, for these fixed-behavior tools.

## Consequences

- A session now has a **communicated and enforced** scope: the model both sees
  (prompt) and is blocked from (middleware) exceeding its level. This reduces
  wasted attempts and accidental writes outside the project.
- The denylist's security property is preserved and extended: the closed loop
  (outermost priority-1000 audit of the final command) still holds, now layered
  with level checks.
- Core gains three generic hooks — `registerToolFilter`, `registerSlashCommand`,
  `SessionStore.lastEvent` — without acquiring any permission semantics
  (P1/P2/P6 respected). The cost is a slightly larger core API surface,
  acceptable at 0.0.x.
- `denylist.ts` is retained and re-exported for backward compatibility and the
  `check-denylist.ts` closed-loop test; `permission.ts` composes it.
- `baseExtension` now reproduces the default set as: reference tools +
  `permissionMiddleware` (priority 1000) + permission extension (filter +
  prompt section + `/level`). One line still reproduces the default harness.
- Consumers assembling their own extension set inherit the same
  responsibility as before (ADR-0005 Q3): mount the permission middleware at
  priority 1000 and register the filter / contribute the prompt section
  (now a `system_prompt`-stack middleware, ADR-0008) if they want the same
  guarantees.
- Breaking change: `HarnessApi` gains new members (additive); `buildToolDefs`
  now applies filters (behavioral, but no consumer relied on unfiltered defs
  beyond the model-facing surface). `main.ts` slash dispatch changes shape.
