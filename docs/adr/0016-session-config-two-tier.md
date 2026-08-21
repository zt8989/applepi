# ADR-0016: Unified Session Config + Two-Tier (Global/Session) LLM Configuration

## Status

Accepted — 2026-08-21, decided via `/grill-with-docs` (5 rounds). Design-recorded
only; implementation pending (ADR-0015 migration in progress).

**Re-scopes / supersedes parts of ADR-0014** (its `lastUsedModel` / `lastUsedLevel`
global-only single record), **ADR-0009's `level/set` event storage**, and the
`reasoning/set` event override from the composer-level design. **Reverses the Q13
decision recorded in CONTEXT.md** ("no per-session model variant").

## Context

Session-scoped state has accumulated across three carriers with no governing
principle: global-only fields in `settings.json` (`lastUsedModel`, `lastUsedLevel`),
the in-memory `session.config` object (only `workspace` today, **never persisted**),
and lifecycle events in the session jsonl (`level/set`, `reasoning/set`, plus
`title/set`/`pin/set`/`notify/set` metadata). The override cascade is bespoke per
key: reasoning = `reasoning/set` ?? `lastUsedLevel` ?? `medium`; permission =
`level/set` ?? `workspace` (no global tier); model = global-only (Q13). ADR-0015
says `mode` lives in `session.config` and is restored on resume — but
`session.config` is not persisted at all, so that guarantee is unfulfillable today.

Three user-led challenges converge:

1. **What is the boundary between global and session config?** Needs a deciding
   principle, not a per-key whim.
2. **One carrier.** Session config should be a single persistent object, not a
   mix of in-memory fields and events.
3. **One cascade.** The resolution formula should be uniform, with every
   session-overridable key getting a global default slot.

## Decisions

### Boundary principle

A setting is **session-scoped** iff the user could reasonably want different
values in two different sessions; otherwise it is global. Constraints by this
rule: providers & secrets are pure infrastructure (always global, never
session-tuned); model / reasoning / permission are "may differ per session"
→ session-overridable with a global default; `workspace` / `mode` are session
identity (build-time, immutable in-session).

### One carrier: `session.config`, persisted as a sibling `<id>.config.json>`

- `session.config` is the single unified session-config object, types as
  `SessionConfig = { workspace?, mode?, model?, reasoningLevel?, permissionLevel? }`.
- Persisted in a **sibling file** `<session_id>.config.json` next to
  `<session_id>.jsonl` (same root, same id). The jsonl keeps **only audit and
  messages** — all config-change events are removed from it (no `reasoning/set`,
  no `level/set`).
- **Override-only (snapshot vs diff → diff).** The file stores only values the
  user **explicitly set in this session** (`model?`/`reasoningLevel?`/
  `permissionLevel?`) plus the identity fields (`workspace` / `mode`). It is
  **not** a snapshot of global defaults at creation: `general` changes propagate
  to every session that has not overridden the key.
- The in-memory `session.config` mirror is loaded at resume and rewritten on
  every runtime change (full rewrite + atomic tmp+rename).

### Storage vs semantics ownership (core)

- **`session` module** owns the file: `SessionStore.loadConfig()` /
  `SessionStore.saveConfig(config)`. `loadConfig` on a missing/corrupt file →
  `{}` (no overrides; not a required config, so **no fail-fast** — P11 applies
  to required global config only). `saveConfig` is a full atomic rewrite.
- **`config` module** owns the cascade as a pure function:
  `resolveSessionConfig(sessionConfig?, general?) → { model, reasoningLevel, permissionLevel }`.
  `resolveLlmConfig` converges onto this cascade (kills the separate last-used
  resolution path).

### Uniform cascade + global "general" block

- Formula: **`会话覆盖 ?? general 默认 ?? 内置默认`** for every overridable key.
- `settings.json` gains a **`general` block**:
  `{ providers, general: { model?, reasoningLevel?, permissionLevel? } }`.
  Top-level `lastUsedModel` / `lastUsedLevel` are **deleted with no compatible
  read** (Q17=A); the operator re-configures via the 设置-通用设置 (Settings →
  General) page. (Deliberately unlike ADR-0014's one-time migration: this is a
  design-phase reset of a global preference, not a session-history migration.)
- Built-in defaults: `reasoningLevel` → `medium`; `permissionLevel` →
  `workspace`. **Model has no static builtin** — its default tier is
  **read-time computed** (never persisted): `覆盖 ?? general.model ?? 第一个可用
  provider 的第一个模型`, re-derived live whenever the default's provider is
  deleted or its catalog empties (Q16 partial / Q19=A: compute-at-read, no
  write-back repair).

### Mutability

- **Build-time immutable in-session**: `workspace`, `mode`. Written once at
  session creation; not changeable mid-session.
- **Runtime-mutable**: `model`, `reasoningLevel`, `permissionLevel`. Each change
  rewrites `<id>.config.json>`.
- Level changes **retain the prompt-rebuild side effect**. The rebuild trigger
  belongs to the caller/shell, not inside the `config` cascade pure function.

### Write paths

- Composer chip / permission capsule write **session overrides only**
  (`session.config.*`); the 设置-通用设置 page writes the **global** `general`
  block only. No implicit global write on session actions.
- New session creation: write identity `{ workspace, mode }` once, **do not
  expand** overrides (diff mode); optional pre-chosen values carried on the first
  message (model/reasoning/level) become initial overrides.
- Resume: `loadConfig()` → in-memory `session.config` → cascade → rebuild spec
  (restores `mode` per ADR-0015).

### Permission level home (Q8=A)

`permissionLevel` lives in `session.config` (override) with a `general.permissionLevel`
default. The `level/set` jsonl event is removed; security restore reads
`session.config` instead of `session.scratch[PERMISSION_SCRATCH_KEY]`.
**Known trade-off (accepted)**: level changes no longer appear on the append-only
audit timeline — the "who changed the level and when" history is lost. This is
recorded here so future readers do not treat it as a bug.

### Empty-global-model UX

When the cascade resolves **no model** (no providers / empty catalog / no
`general.model`), the **web** interface forces the model selector (not the full
settings) at send time and does **not** send until a valid model is chosen;
re-posed on every send until configured. **CLI is out of scope** — it is slated
for removal and does not constrain this design (P6 core primitives remain
UI-agnostic regardless).

### Migration / compatibility

No backward-compatible migration of existing sessions (Q13=A): old sessions
without a `<id>.config.json>` are treated as new (no `reasoning/set` / `level/set`
fallback). These are migration-era test artifacts; `mode` has no legacy value to
carry.

## Consequences

- **One carrier**: `session.config` (persisted) is the single reading of session
  state; jsonl is audit+messages only.
- **One cascade**: uniform override → general → builtin, owned by core, shared by
  all UIs (P6); the web-adapter hand-rolled `sessionReasoningLevel` cascade
  disappears into core.
- **Dynamic model default with no repair path**: provider deletion self-heals by
  construction (compute-at-read).
- **Security restore changes source**: `getPermissionLevel` reads
  `session.config.permissionLevel`; level-change audit is explicitly sacrificed.
- **`general` defaults propagate** to untouched sessions (diff mode), making the
  设置-通用设置 page an actual runtime lever, not a creation-time snapshot.

## Superseded / re-scoped

- **Re-scopes ADR-0014**: `lastUsedModel` / `lastUsedLevel` (global-only single
  record, Q13) → `general.model?` / `general.reasoningLevel?` default slots plus
  session overrides; model gains a session tier.
- **Re-scopes ADR-0009 / the permission-level storage**: `level/set` jsonl event →
  `session.config.permissionLevel` override + `general.permissionLevel` default.
- **Removes the `reasoning/set` event** override path (composer-level design) →
  `session.config.reasoningLevel`.
