# ADR-0009: Security as Tool Self-Determination — Core-Built SecurityPolicy + Extension Reload

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` rounds 1–5 (Q1–Q23).

## Context

Two prior security decisions converged on an awkward middle ground:

- **ADR-0005** moved security out of core on the argument that *"privilege is a
  registration convention, not a location"* — the denylist's power came from
  mounting outermost (priority 1000), and whoever assembled an extension set
  inherited the duty to mount it. Security therefore existed **by convention**,
  and could be forgotten.
- **ADR-0007** added permission levels with a **double layer**:
  registration-time cropping (`registerToolFilter`, hiding/cropping what the
  model sees) + runtime interception (`permissionMiddleware` at priority 1000
  with ENTRY/EXIT audit). But the implementation was **per-tool-name
  hard-coding** (`checkTool` switches on `bash` / `str_replace_editor` /
  `memory_write`), and **unknown tools were allowed by default** — unified
  defense only held for *recognized* tools.

A `/grill-with-docs` session (Q1–Q23) asked the root question: *should safety
be each extension's own responsibility, or enforced uniformly at the outermost
tool-call boundary?* The interview resolved to a third shape: **tools
determine their own behavior from the permission level in context; core owns
the level state and the extension lifecycle, and stops trying to know any
specific tool.**

## Decisions

### Threat model (Q1=a)

- Security defends **only against model overreach**. Extensions are fully
  trusted (zero-isolation, unchanged from ADR-0005). Defending against
  *malicious* extensions requires OS-level isolation, which is out of scope.
- Consequence: a tool that does not read the level may run at full power even
  at `readonly`. This is accepted explicitly (Q11=a) — readonly is a
  **gentleman's agreement**, not a hard boundary.

### Responsibility model (Q2=c refined by Q4/Q5)

- **No ToolSpec declaration fields. No registration-time requests or
  validation.** The context carries the current level (`session.scratch[
  '__permissionLevel']`); each tool reads it in `execute` and **self-limits**:
  `bash` restricts itself to a read-only whitelist at `readonly`,
  `str_replace_editor` to `view`, etc. Q2=c therefore concretizes as
  「context injection → tool self-determination」.

### Mechanism ownership (Q3=b + Q7=b)

- **Permission is built into core**: core ships a `SecurityPolicy` interface
  **with a default implementation** that is mounted by default and cannot be
  bypassed. Consumers may explicitly replace the policy; replacing means
  self-responsibility. This partially reverses ADR-0005 (security moves back
  into core), evolving it from 「registration convention」 to 「core mechanism」.

### No parameter-level cropping (Q8=b + Q19)

- **`registerToolFilter`, the `ToolFilter` type, and the filter loop in
  `buildToolDefs()` are deleted.** Registered tools are never schema-cropped;
  the model always sees the full surface. Violations are rejected at runtime
  by the tool's own `execute`. Tool-**set** switching is handled by extension
  reload (below), not by cropping.

### Denylist moves into the bash tool (Q9=a)

- The `DENY` regexes and their check migrate into `bash`'s `execute` (run
  before execution, at every level). Core holds **no tool-specific rules**.
  A future `powershell`-style tool ships its own danger patterns.

### Level skeleton belongs to the default SecurityPolicy (Q10=a)

- The three-value level model, the `level/set` event, `lastEvent` restore,
  the 「Permission Level」 system-prompt section, and `/level` all live in
  core's default `SecurityPolicy`. Replacing the policy replaces the whole
  skeleton. The prompt section still rides the `system_prompt` stack
  (ADR-0008 unaffected).

### Runtime gate removed (Q12=a)

- `permissionMiddleware` (the priority-1000 ENTRY/EXIT audit) is **deleted**.
  The "gate" degrades to a **level-context guarantee**: core ensures every
  tool `execute` sees the current level. `SecurityPolicy` has no runtime
  middleware mounting point in the default implementation.

### Per-tool special-casing migrates into tools (Q6=a)

- `checkBash`, `checkSre`, `identifyWriteTargets`, `READONLY_BASH_COMMANDS`,
  and `WRITE_COMMANDS` move into the `bash` / `str_replace_editor`
  implementations. `isInsideProjectRoot` (realpath prefix check) is exported
  from core as a **generic pure-function primitive** for tools to reuse —
  a shared mechanism, not a tool-specific rule.

### Extension reload: dynamic permission via lifecycle management (Q13=b, Q14=b, Q15=a, Q17=a, Q21–Q23)

- **Registration scopes (Q13=b)** — core tracks every `registerTool` / `use` /
  `registerSlashCommand` call against the extension currently being set up;
  on rebuild it revokes the whole scope. Extensions stay oblivious: they only
  register, core handles teardown.
- **Two-tier triggering (Q14=b + amendment)** —
  - `level/set` (`/level`) is **light**: rebuild the system prompt
    (permission section) only; **no tool is unloaded**. Level is just a change
    in the size of permission; tool behavior adapts per-call.
  - Extension added/removed (`/reload`) is **heavy**: revoke all registrations
    → re-scan the extensions dir → re-`setup` → rebuild the prompt.
- **Tool set vs. tool behavior (Q15=a)** — the tool **set** is a function of
  the extension set (managed by reload); tool **behavior** is a function of
  level (self-determined per call). All tools stay registered at every level.
- **`/reload` redefined (Q17=a)** — no longer `new Harness`; it is
  extension unload + re-inject + prompt rebuild, preserving
  `session.scratch` / `session.history`.
- **External side effects (Q21–Q23)** — new `api.useEffect(fn: () =>
  (() => void) | void)`: run synchronously during `setup`, the returned
  cleanup is recorded to the current scope; may be called multiple times.
  Reload order: ① run all cleanups (release external resources first) →
  ② revoke registrations → ③ re-scan + re-`setup` → ④ rebuild prompt.
  Cleanup errors are soft-isolated (caught, logged, never abort the reload).
  Effects must not rely on process-level state surviving a reload.

## Consequences

- **ADR-0005 is partially reversed**: the security mechanism returns to core
  (as `SecurityPolicy`), while reference tools stay in `@applepi/extensions`.
  The "privilege is a convention" conclusion is superseded by "security is a
  core mechanism" — the same insight (location ≠ privilege) taken to its end:
  don't rely on convention, make it structural.
- **ADR-0007 is superseded**: the double layer (cropping + runtime
  interception) is replaced by tool self-determination. The level model,
  `level/set` event, prompt section, and `/level` survive, now owned by core.
- **ADR-0008 is superseded by ADR-0010**: the `system_prompt` stack becomes
  three `prompt/*` block stacks; the permission section now rides the
  `prompt/permission` block (originally: "ADR-0008 is unaffected: the
  `system_prompt` stack continues to carry the permission section").
- **Security posture changes**: `readonly` shifts from a hard boundary to a
  cooperative one; the uniform layer no longer intercepts anything at runtime.
  This is the accepted cost of letting tools own their safety (Q11=a).
- **Core API changes**: `registerToolFilter` and `ToolFilter` are removed;
  `useEffect` is added; a `reload`-capable registration-scope tracker and the
  `SecurityPolicy` interface + default implementation land in core.
- **Migration checklist** (see CONTEXT.md "Security model"):
  1. Delete `packages/extensions/permission.ts` (`createPermissionExtension`).
  2. Add core `security.ts` (SecurityPolicy + default impl) and `reload.ts`
     (registration scopes + unload/re-inject + useEffect).
  3. Fold `DENY` + `identifyWriteTargets` + `READONLY_BASH_COMMANDS` +
     `WRITE_COMMANDS` into `tools/bash.ts`; fold the sre path rule into
     `tools/str_replace_editor.ts`; export `isInsideProjectRoot` from core.
  4. `memory.ts` / `skills.ts`: implement self-determination in `execute`
     (`memory_write` = write, rejected at readonly; `skill_load` /
     `memory_read` = read, allowed everywhere).
  5. Slim `baseExtension`: reference tools + memory/skills only; no permission
     extension.
  6. Rewrite `check-permission.ts` → `check-security.ts`: bash readonly
     whitelist, sre view-only, denylist floor at every level, `/level` event +
     prompt rebuild (no tool unload), `/reload` unload + re-inject.
