# ADR-0013: Web Workspace Discovery — Manifest-Only + Basename Display

## Status

Accepted — 2026-08-20, decided via `/grill-with-docs` (workspace list bug fix, Q1–Q4).

## Context

`listWorkspaces()` originally called `fs.readdir(~/.applepi/sessions/)` and treated
**every** subdirectory there as a workspace. That meant stale test directories
(`test-ws-*`) and any historical subdir all showed up in the sidebar / dropdown /
composer pill. After selecting `my-pi-desktop` the sidebar exploded to ~22
workspaces, while `.manifest.json` actually recorded only 2 legitimate ones
(`applepi`, `applepi/apps/agent`).

The user required: ① the workspace list must read **only** `.manifest.json`;
② the sidebar and chat-bar must show only the **last path segment** of each
workspace.

## Decisions

### 1. Discovery source = manifest-only

- `listWorkspaces()` no longer scans the sessions dir. It iterates the
  slug→path entries returned by `readManifest()`.
- Each manifest entry still resolves its sessions by slug
  (`~/.applepi/sessions/<slug>/*.jsonl`) — session listing is preserved, only
  the *discovery* mechanism changed.
- Removed the `unslugWorkspace` reverse-resolve inside `listWorkspaces`
  (manifest already supplies the path). `unslugWorkspace` is retained for
  `bindSession`, which still recovers the toolRoot from a stale localStorage slug.

### 2. Display name = basename, logic key = full path

- The server adds `name = path.basename(path)` to `WorkspaceInfo`
  (e.g. `applepi`).
- The three client surfaces (sidebar workspace group, workspace dropdown,
  composer pill) render `name`, not the full path. For same-basename collisions,
  a `title` shows the full path on hover.
- **Selection / active-highlight / `openSession` / `store.workspace` storage all
  keep using the full path** (`path`). Display name and key are strictly
  separated — otherwise a bare `applepi` would be used as a directory to create
  a workspace, or the active comparison would never match.
- The sidebar "空间(N)" count changed from *total session count* to *workspace
  count* (matches the "空间" label; each workspace still shows its own session
  count as a small number on the right).

### 3. Physical leftover dirs are not auto-deleted

- After manifest-only discovery, `test-ws-*` no longer appear in the UI but
  still physically exist under `~/.applepi/sessions/`. Per file-safety rules
  they are **not deleted by default** — only hidden from the UI. Cleanup
  requires explicit user confirmation.

## Consequences

- Sidebar / dropdown / pill show only manifest-registered workspaces (2 by
  default), no longer polluted by test leftovers.
- Workspace labels are compact (basename); full path is one hover away.
- New workspaces must go through `addWorkspace` (writes the manifest) to appear
  — CLI-created-but-unregistered historical workspaces no longer auto-surface in
  the web. This is the trade-off: cleaner and predictable, at the cost of
  auto-discovery.
- Deleting directories needs explicit user confirmation; data is safe.

## Amendment (2026-08-20): Display-name override + logical delete

The original ADR treated the manifest entry as a plain `slug → path` string.
To support user-facing rename and removal without touching the on-disk
directory, the manifest entry type was extended to
`string | { path: string; name?: string }`:

- **Rename** (`PATCH /api/workspaces { action: 'rename', slug, name }`) stores a
  `name` override in the manifest only. An empty name clears the override so the
  display falls back to `path.basename`. The on-disk directory is never renamed.
- **Remove** (`PATCH /api/workspaces { action: 'remove', slug }`) is a *logical
  delete*: it drops the manifest entry so `listWorkspaces` no longer returns the
  workspace, but every session `.jsonl` file stays on disk. Re-adding the same
  path (via `addWorkspace`) restores it. This is distinct from physical deletion
  and keeps ADR-0013's file-safety guarantee intact.

`entryPath()` / `entryName()` normalize both legacy string entries and the new
object form, so old manifests keep working.
