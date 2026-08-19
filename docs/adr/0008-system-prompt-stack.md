# ADR-0008: The System Prompt is Built on the Onion — a `system_prompt` Stack

## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` (rounds 1–2, Q1–Q8).
**Supersedes the Q10=c contributor API from ADR-0002** (the
`addSystemPromptContributor` mechanism; note ADR-0007's own Q10=c refers to
the *double-layer* tool-cropping decision and is unaffected).

## Context

Since ADR-0002 (its Q10=c), the system prompt was assembled from a bespoke
registration API: `api.addSystemPromptContributor(fn, label)` collected
section-builder functions; `buildSystemPrompt()` ran them in registration
order and joined the non-empty results with `\n\n`. Three call sites existed
(the agent's `base`, the permission extension's「权限声明」section, and the
skills extension), plus the old `llm`-middleware injection it had replaced.

The user challenged this API: the harness already expresses every other
cross-cutting concern as **onion middleware** (session / llm / tool stacks —
P3) with three built-in powers — observe, veto (skip `next()`), and rewrite
`ctx`. A bespoke contributor registry was the odd one out: it could only
*append a string*, could not see the accumulated prompt, could not rewrite it,
and its ordering (registration order) was implicit. Two concrete defects
surfaced during the grill: the actual registration order in the agent put the
permission section *before* base (contradicting ADR-0002's "base first"
claim), and the `sections` event payload described what was *registered*,
not what was *built*.

The decision: **drop the contributor API and build the system prompt by
running the `system_prompt` onion stack** — extensions become middleware that
mutate a build context, exactly like the other three stacks.

## Decisions

- **A fourth onion stack `system_prompt` (Q1=a)** — `HookStack` gains
  `'system_prompt'`; `OnionBus` initializes it empty. `Harness.buildSystemPrompt()`
  becomes `bus.run('system_prompt', ctx, noop)` where `ctx` carries
  `promptParts: string[]` and `sections: string[]` (both seeded `[]`).
  Reuses the existing `api.use(stack, mw, { priority })` — **no new HarnessApi
  method**. Amends P3: a genuinely distinct lifecycle event (the prompt build)
  may add a stack; the default is still to prefer existing stacks.
- **Append is the convention, rewrite is allowed (Q2=c)** — middleware
  **push a section** into `ctx.promptParts` on entry (only when it has
  content). Because the prompt is a mutable array, a middleware may also
  **wholesale replace** `ctx.promptParts` — the onion's rewrite power, now
  available to prompt builders too (e.g. a future "replace everything"
  extension). Concretely: replace = assign a new array, which differs from the
  rejected string-accumulator option only in spelling (Q7=b).
- **Harness owns joining & normalization** — after the stack runs,
  `buildSystemPrompt()` joins `filter(Boolean).join('\n\n')`, collapses blank
  runs, and returns `{ prompt, sections }` (a `BuiltSystemPrompt`). Extensions
  never manage separators.
- **Sections are build-time truth (Q8=a)** — middleware pushes its label into
  `ctx.sections` only when it contributed a non-empty section. The
  `system_prompt/start|end` event payload and the agent's startup log use the
  **built** sections, not a registration-time list. `contributorSections()`
  is deleted.
- **Ordering by priority, base outermost (Q3=a)** — the base section mounts at
  priority 1000 so it enters first and its section comes first; extensions
  default to 0 in registration order. This fixes the latent ordering bug
  (permission used to precede base). The base section is owned by
  `baseExtension` in `@applepi/extensions` (moved out of `main.ts` on
  2026-08-19), so every consumer that registers `baseExtension` gets the full
  wiring.
- **Must call `next()`; veto is not persistence-blocking (Q6=a)** — by
  convention every section middleware calls `next()`. Not calling it merely
  skips later sections; it never blocks prompt persistence. The bus's soft
  isolation still applies (a throwing middleware is skipped, the build
  completes).
- **API removed, no sugar (Q5=a)** — `HarnessApi.addSystemPromptContributor`
  and the `SystemPromptContributor` type are deleted; no compatibility
  wrapper. All call sites migrate to `api.use('system_prompt', ...)`:
  `baseExtension` (base section, priority 1000 — moved out of `main.ts` on
  2026-08-19), `permission.ts` (permission section), `skills.ts` (skills
  section), and the three check scripts.

## Consequences

- The system prompt is now **observable, veto-able, and rewritable** at build
  time by any extension, through the same middleware contract as the other
  stacks — one mental model for all cross-cutting behavior (P3).
- `HarnessApi` shrinks by one bespoke method; `use()` gains no options
  (labels come from the build, not registration).
- The `system_prompt/start|end` payload becomes honest: it lists the sections
  that actually contributed to this build.
- Ordering is explicit and fixable via priority instead of implicit
  registration order.
- Breaking change: extensions using `addSystemPromptContributor` must switch
  to `api.use('system_prompt', ...)`; `buildSystemPrompt()` returns an object
  instead of a string; `contributorSections()` is gone. In-repo call sites are
  migrated (check-skills / check-session / check-permission / test/skills.mjs
  updated accordingly).

## Amendment (2026-08-19, follow-up grill): all events go through `emit(event)`

The follow-up discussion removed the last bespoke method. `HarnessApi`
no longer exposes `emitSystemPrompt()` or `appendEvent()`; it exposes a
**single publish entry `emit(event, payload?)`**:

- **Core-handled event** — `system_prompt` is registered in the harness's
  internal handler map: rebuild the prompt via the `system_prompt` stack,
  persist it (the private `persistSystemPrompt` path: start event + system
  message + end event, ADR-0006 pair kept), and return `{ prompt, sections }`
  so callers can log sections.
- **Fallback** — any other event (`skill/start|end`, `reload/start|end`,
  `level/set`) writes a lifecycle event line to the session store (P7).
- `RunOpts.emitSystemPrompt` is renamed to `RunOpts.persistSystemPrompt` —
  it is a run-time flag (persist the built prompt this run), not an event;
  `run()` keeps calling the single `persistSystemPrompt` path directly to
  avoid a double build.
- All in-repo callers migrated: `main.ts` (startup, `/reload`, `/new`),
  `permission.ts` (`/level`), `check-session.ts`. `SessionStore.appendEvent`
  remains as the storage primitive (core-owned, P6).
