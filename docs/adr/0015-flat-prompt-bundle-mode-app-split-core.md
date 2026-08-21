# ADR-0015: Flat System Prompt + Bundle/Mode/App + Split Core

## Status

Accepted — 2026-08-21, decided via `/grill-with-docs` (8 rounds).

**Supersedes ADR-0008** (the single `system_prompt` onion stack) and **ADR-0010**
(the PromptBag of three block stacks). Re-scopes parts of **ADR-0009** (the
permission declaration section moves out of core into bundles; enforcement
stays core) and reframes **ADR-0005** (`baseExtension` → the `base` bundle in a
new `packages/bundle`).

## Context

The system prompt has been built incrementally through two onion generations
(ADR-0008 single `system_prompt` stack → ADR-0010 three `prompt/base|permission|skills`
block stacks), and the capability set has been injected through a generic
extension mechanism (`registerExtension`/`SetupFn`, `OnionBus`, `HookStack`,
middleware, the `emit` event bus). Three user-led challenges converge on a
simpler shape:

1. **Why does `registerExtension` exist?** Core's real job is LLM interaction
   — building the `system_prompt` and exposing the tool catalog. The generic
   capability-injection machinery (onion stacks, middleware, `HarnessApi`,
   `use`/`useEffect`) is not core's concern; capability assembly belongs to
   the app layer.
2. **Split core.** Core should be a set of single-responsibility deep modules
   — `llm` (only prompt + tools), `loop` (only the turn loop), and so on —
   wired by a thin shell.
3. **Flat prompt.** Stop chunking the prompt into blocks. A session runs
   exactly one capability **bundle**; the prompt is a single flat buffer of
   sequentially-concatenated fragments, and plugins only **append** to the tail.

There is no `extends`. `base` and `standard` are sibling, self-contained
capability bundles — `standard` does **not** inherit `base`. Web/TUI are
**apps** (interfaces), not bundles or modes.

## Decisions

### Core: split into deep modules

Core is decomposed into single-responsibility modules, wired by a thin
**Harness** shell that assembles an agent and its lifecycle:

- **`llm`** — the LLM-interaction surface. Consumes `{ prompt: string[],
  tools: ToolSpec[], history }` and produces/streams **one** model response
  segment (tool_calls included), wrapping the concrete model SDK. Owns prompt
  consumption and the tool catalog. Deep, SDK-hiding.
- **`loop`** — drives the **multi-turn** loop: user input → call `llm` →
  execute tools → feed results back → …; owns pause / tool-approval / resume.
  Depends on `llm` but knows no model-SDK detail.
- **`session`** — jsonl persistence + resume. Keeps a minimal **append
  lifecycle-event-to-jsonl** primitive (`level/set`, `reasoning/set`,
  `title/set`, `pin/set`, …) for UI/CLI state; it is an ordinary state record,
  not a prompt-rebuild trigger.
- **`config`** — `settings.json`, provider registry/resolution, reasoning
  levels.
- **`security`** — permission-level enforcement, as an **adapter/seam at tool
  execution**: `loop` queries security for the current level and passes a
  level-carrying `ctx` to tool `execute` (tool self-determination). Core keeps
  the enforcement mechanism; it does **not** own the permission prompt text.
- **`trace`** — observability.
- **Harness shell** — wires the modules into a runnable agent + lifecycle.

**Removed from core**: `registerExtension` / `SetupFn` / `HarnessApi` /
`OnionBus` / `HookStack` / middleware / onion stacks, the generic `emit` event
bus, and the `system_prompt` event family. Core's `llm` accepts a ready
`{ prompt, tools }` spec; it does not host a capability-injection mechanism.

The `registerExtension` name survives only as an **app-layer plugin loader**
and as the shape in which `packages/bundle` producers are expressed — not as a
core primitive.

### system_prompt: flat, sequential, append-only at the tail

- **Single flat buffer.** The three block stacks (`prompt/base|permission|skills`)
  are removed. No blocks, no prompt middleware/onion, no `PromptBag`.
- **Pure sequential concatenation** of fragments in declared order, across
  **three hard-coded layers**:
  `bundle 片段 → app 接口片段 → plugin 尾部片段`.
  Lower layers cannot rewrite upper layers; order is declared, not negotiated.
- **Spec-driven one-shot assembly.** At session creation the app picks a
  bundle (`base` or `standard`), obtains `{ prompt, tools }`, overlays app
  interface fragments and plugin appends, and hands the assembled spec to
  `llm`. A rebuild simply re-reads the same spec and reassembles — there is no
  dynamic middleware.

### Permission declaration is a bundle prompt fragment

Each of `base` / `standard` declares its **own** permission/capability
declaration section as an ordinary prompt fragment, tailored to its own tool
set. Core security enforces levels at the tool seam but does not write the
prompt text. (Re-scopes ADR-0009's core-owned「Permission Level」section into
the bundles; enforcement stays core.)

> **Revision note (deepen-architecture #01, softened)** — the declaration is
> no longer authored per-bundle as a fixed string. `base` and `standard` share
> a single assembly-time `permissionFragment` (`packages/bundle/src/assemble.ts`)
> that renders `## Permission & Capability` from the **actually resolved tool
> set** (`spec.tools` ∪ tools of capabilities that have a factory,
> `enableBundleSpec`-equivalent), so the prompt can never claim tools that are
> not wired. The "own prompt" clause is also softened: both bundles now share
> the same minimal persona string. Unwired declared capability ids are echoed
> via `console.warn` by `enableBundleSpec` instead of being silently skipped.

### Bundles, modes, apps, plugins

- **Bundle** — a self-contained capability unit. `base` = exactly `bash` +
  `str_replace_editor` (two tools, minimal prompt; **no** memory/skills/plan/
  goal/subagent). `standard` = a self-contained full set (its own bash/sre
  reusing shared tool implementations, plus memory/skills/web/plan/goal/
  subagent/workflow/todo/ask_user; its own prompt — *softened by the revision
  note above: both bundles share the minimal persona*). **Siblings —
  `standard` does not inherit `base`.** No `extends` concept anywhere.
- **Mode** — a bundle hosted by an app. `base`/`standard` are both bundle and
  mode; **mode is not a separate concept** beyond "the bundle a session runs
  under."
- **App** — `web`, `tui` (design-only for now). Apps are **interfaces**, not
  bundles. An app hosts a mode selection and **overlays its own interface
  capabilities** (web-interface tools/env declared in `apps/web`) on the
  chosen bundle. Interface axis (web/tui) × capability axis (base/standard)
  are orthogonal.
- **Plugin (custom)** — external, append-only. Appends prompt fragments at
  the tail and registers new tools/skills; cannot reorder or remove base/
  standard internals. Loaded after the active bundle (extensions-dir loader).

### Mode selection & persistence

- Chosen **once at session creation** (web new-chat picker / CLI arg). Not
  hot-swappable mid-session; **not** a `mode/set` event.
- Stored in **`session.config.mode`** (build-time, immutable in-session);
  resume rebuilds the matching spec.

### Packaging

- New **`packages/bundle`** holds `base` / `standard` bundles as pure
  declarative producers `(env) => ({ prompt, tools })`, above core.
- `packages/extensions` keeps the reference tool implementations (bash/sre/
  memory/skills) that bundles reference.
- `packages/core` becomes the module set above; `apps/*` are apps.

## Consequences

- **Ordering is structural and trivial**: a session runs exactly one
  capability bundle, so the flat buffer's order is bundle fragments → app
  interface fragments → plugin tail. The three-generation ordering defects
  (ADR-0008 Q3 inversion, ADR-0010's need for structural block order) cannot
  recur — there is no cross-bundle ordering to negotiate.
- **Core is gettable smaller.** The extension/onion machinery, the `emit`
  event bus, and the `system_prompt` event family exit core; `llm` takes a
  ready spec and hides the SDK.
- **Plugins are constrained by construction**: append-only to the tail, so a
  third-party plugin can never corrupt base/standard instruction order.
- **Security does not regress**: enforcement (level model, ctx injection,
  tool self-determination) stays in core at the tool seam; only the
  declaration text becomes a bundle-owned fragment.
- **Mode is immutable per session** and recorded at build time — no
  mid-session capability flips, no replay event.

## Superseded / re-scoped

- **Supersedes ADR-0008** (single `system_prompt` onion stack) and **ADR-0010**
  (PromptBag block stacks) with the flat-buffer model.
- **Re-scopes ADR-0009** (the permission declaration section moves into
  bundles; enforcement remains core at the tool seam).
- **Reframes ADR-0005** (`baseExtension` → the `base` bundle in
  `packages/bundle`; the generic injection machinery leaves core).
