# ADR-0010: The System Prompt is a PromptBag of Blocks — Three Block Stacks

> **修订注记（2026-08-22）**：`@applepi/extensions` 包已更名为 `@applepi/extension`（包名 = 核心概念名单数约定；正文沿用决策当时名称）。
## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` (rounds 1–3, Q1–Q17).
**Supersedes ADR-0008** (the single `system_prompt` onion stack).

## Context

ADR-0008 built the system prompt by running one `system_prompt` onion stack;
middleware pushed string sections into `ctx.promptParts` and their labels into
`ctx.sections`. An ordering defect surfaced in practice: the core SecurityPolicy
installs its 「Permission Level」 middleware **in the Harness constructor** at
priority 1000, *before* `baseExtension` is registered (also at 1000). Because
`OnionBus.chain()` sorts stable (`b.priority - a.priority`), equal priorities
keep insertion order — so the permission section landed **before** the base
section, contradicting ADR-0008 Q3=a's stated intent ("base outermost, base
first"). The observed system message began with `## Permission Level: workspace`
and only then said "You are a minimal local agent harness."

The deeper problem: ordering by **priority** is still a convention — it
depends on every contributor agreeing on priorities and the bus's tie-breaking
being stable. The user challenged this: *ordering should be structural, not
negotiated.* Each block should be its own stack, so "permission installed
first" can never push it ahead of base. At the same time, the accumulation
model was upgraded from a bare `string[]` to a **PromptBag**: an object with
one array per block plus a `set(stackName, value)` method, so writes are a
single auditable entry and rewrites (replace / functional update) are
first-class.

A follow-up simplified the block set: a separate `tools` block was dropped —
tool information stays entirely in the Vercel AI SDK tool defs (the model sees
the full surface, ADR-0009 Q8=b), and the system prompt carries no tool
listing. The base block's "You have two reference tools" sentence is deleted
for the same reason (no duplication, no drift as extensions add tools).

## Decisions

- **Three canonical blocks, in fixed order (Q2/Q16/Q17)** — `base`（系统提示词）→
  `permission`（权限）→ `skills`（技能）. Order is **structural**: `buildSystemPrompt()`
  runs the three block stacks **in that sequence**; the join order follows the
  block order, never registration order or priority. A `tools` block was
  considered and **dropped** (Q16): tool info lives only in tool defs.
- **Block name = stack name, with a `prompt/` prefix (Q5/Q6/Q16)** —
  `HookStack` becomes `'session' | 'llm' | 'tool' | 'prompt/base' |
  'prompt/permission' | 'prompt/skills'`. The `system_prompt` stack is deleted.
  `api.use('prompt/base', mw)` and `bag.set('base', ...)` share the same
  short block name.
- **PromptBag replaces `promptParts` (Q5/Q7/Q14)** — `Ctx.prompt` is an object
  with three arrays (`base` / `permission` / `skills`) plus `set(block,
  string[] | (old) => string[])`. **Writes go only through `set`** (Q7=b):
  no direct array mutation, so the object stays auditable. The functional form
  receives **this block's** old array (Q14=a); blocks are invisible to each
  other — an updater can only see and change its own block.
- **Rebuild-all semantics (Q4/Q9/Q12)** — any block event triggers a **full**
  rebuild of all three stacks and persists **one** complete system message
  through the single `persistSystemPrompt` path. Block events
  (`system_prompt/base`, `system_prompt/permission`, `system_prompt/skills`)
  are semantic triggers recording *which block changed*; the un-suffixed
  `system_prompt` event remains the full-rebuild entry (session start,
  `/reload`, `/new`). All four event names map to the same handler.
- **Sections = non-empty block names (Q10)** — `buildSystemPrompt()` still
  returns `{ prompt, sections }`; `sections` lists the blocks that actually
  contributed content this build, in canonical order. The
  `system_prompt/start|end` event pair and the persistence path are unchanged.
- **Base content slims (Q13/Q17)** — `BASE_SYSTEM_PROMPT` keeps identity and
  working style only; the "You have two reference tools" sentence is deleted
  (tool info is owned by tool defs, not the prompt).
- **Veto narrows to the block (Q15=a)** — onion veto (skipping `next()`)
  affects only later middleware **within the same block stack**; cross-block
  veto is gone. Persistence is never blocked by a veto (unchanged from
  ADR-0008 Q6).

## Consequences

- **Ordering is now structural.** Installing SecurityPolicy before any
  extension — or registering extensions in any order — can no longer reorder
  blocks. The observed inversion is impossible by construction.
- **Block-level freedom.** An extension mounts on `prompt/<block>` to append
  or replace one block without affecting the others; `set` gives it both
  append (`old => [...old, section]`) and wholesale-replace (`newArray`) power.
- **Priority is still meaningful within a block** (outer first), but no longer
  needed to order blocks — a convention is removed from the system prompt's
  spine.
- **One mental model.** `session` / `llm` / `tool` / `prompt/*` are all onion
  stacks; the prompt build is just three of them run in a fixed sequence over
  a shared PromptBag.
- **Breaking changes** (in-repo call sites migrated): `HookStack` loses
  `system_prompt`, gains three `prompt/*` stacks; `ctx.promptParts` /
  `ctx.sections` are replaced by `ctx.prompt` (PromptBag); contributors
  migrate from `ctx.promptParts!.push(section)` to `bag.set(block, ...)`;
  block events replace the bare `system_prompt` event at call sites where the
  caller knows which block changed (e.g. `/level` → `system_prompt/permission`).
