# ADR-0003: Split the Flattened Package into a Pnpm Workspace

## Status

Accepted — 2026-08-19, decided via `/grill-with-docs` rounds 1–2 (Q1–Q11). Awaiting implement-confirmation.

## Context

The repo was flattened from a monorepo into a single pnpm package at the repo root (`4f15860`), with `src/{core,extensions,agent}` compiled under one `tsconfig.json` and cross-imports as relative paths. The team wants package boundaries back — three independent workspace packages derived from those three folders — so core/extensions/agent build, test, and evolve separately (a future web UI, for example, consumes core without dragging in the agent).

## Decisions

- **Layout (Q1=b)** — community-convention directories, moved with `git mv` (history preserved):
  - `packages/core` ← `src/core`
  - `packages/extensions` ← `src/extensions`
  - `apps/agent` ← `src/agent`
  - `pnpm-workspace.yaml` declares `packages: ["packages/*", "apps/*"]`; the root `src/` is removed.
- **Package names (Q2=b)** — `@applepi/core`, `@applepi/extensions`, `@applepi/agent`. Root package stays `harness`.
- **Cross-package imports (Q3=a)** — by package name (`@applepi/core` etc.), resolved to `dist/` through each package's `exports`/`main`/`types`. In-package relative imports stay relative.
- **Dev/test strategy (Q4=a)** — build-first: `tsx` and `.mjs` tests resolve package names to `dist/`, so dependencies are built before use (per-package scripts build their deps; root `verify` starts from a full `pnpm -r build`).
- **tsconfig (Q5=a)** — shared `tsconfig.base.json` at the root; each package has its own `tsconfig.json` (rootDir = package root, outDir = `dist`). No project references / `tsc -b`.
- **Root as orchestrator (Q6=a)** — root `package.json` keeps `build` (`pnpm -r build`), `dev` (`pnpm --filter @applepi/agent dev`), `test` (`pnpm -r test`), `verify` (build + tests + agent checks). `pnpm dev` / `pnpm verify` usage stays unchanged.
- **Acceptance baseline (Q7=a)** — `pnpm verify` all green (node tests + 6 key-free tsx checks); `pnpm dev` REPL, env-var API keys, slash commands, and `~/.applepi/sessions` paths unchanged; tests stay in their owning package (`core/test/*` in core, `extensions/test/*` in extensions, `agent/scripts/*` in agent).

## Consequences

- Package boundaries are explicit again; dependency direction is enforced (`agent → extensions → core`), which is the point of the workspace.
- Build-first cost returns: running agent code (dev/checks) requires core+extensions built. Mitigated by auto-build in per-package scripts and topological `pnpm -r` ordering.
- Strict pnpm `node_modules` means each package must declare every package whose types it compiles against (e.g. the agent compiles `@applepi/core`'s `.d.ts`, which references `zod`/`ai` types → agent declares them as direct deps).
- Reverses part of the `4f15860` flatten (directory moves back), but git history is preserved via rename detection.
