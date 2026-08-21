import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Harness,
  SessionStore,
  slugWorkspace,
  resolveLlmConfig,
  resolveSessionConfig,
  mergedProviders,
  resolveApiKey,
  loadSettings,
  saveSettings,
  loadDotenv,
  writeDotenvKey,
  BUILTIN_PROVIDERS,
  providerSecretName,
  PERMISSION_LEVELS,
  REASONING_LEVELS,
  DEFAULT_REASONING_LEVEL,
  applyPermissionLevel,
  type ResolvedLlmConfig,
  type ProviderConfig,
  type ProviderProtocol,
  type ModelEntry,
  type ReasoningLevel,
  type PermissionLevel,
  type GeneralConfig,
} from '@applepi/core';
import {
  makeBundleSpec,
  bundleEnv,
  enableBundleSpec,
  assembleFlatPrompt,
} from '@applepi/bundle';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * Server-side wiring for the web interface (ADR-0011 + ADR-0015): one Harness
 * per (workspace, mode) pair (the bundle's tool registry is immutable per
 * session — chosen once at creation, ADR-0015), one provider model from
 * ~/.applepi (ADR-0004), sessions mapped 1:1 to the core SessionStore jsonl.
 */

const SESSIONS_DIR = () => path.join(os.homedir(), '.applepi', 'sessions');
const MANIFEST_FILE = () => path.join(SESSIONS_DIR(), '.manifest.json');

/**
 * Best-effort reverse of `slugWorkspace`: the slug 'Users-x-applepi' came from
 * '/Users/x/applepi', but the mapping is ambiguous (dirs may contain '-'). We
 * try every split point longest-first — first i slug tokens as individual dirs,
 * the remaining tokens merged back into one — and accept the FIRST candidate
 * that exists on disk. Workspaces created by the CLI have no manifest entry,
 * so this is how the web recovers their real path.
 */
export async function unslugWorkspace(slug: string): Promise<string | null> {
  const parts = slug.split('-');
  if (parts.length < 2) return null;
  for (let split = parts.length - 1; split >= 1; split--) {
    const candidate =
      '/' + parts.slice(0, split).join('/') + '/' + parts.slice(split).join('-');
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // keep trying shorter splits
    }
  }
  return null;
}

/** Resolve a workspace reference (path or slug) to a slug token. */
export function workspaceToSlug(workspace: string): string {
  if (!workspace.includes('/') && !workspace.includes('\\')) return workspace; // already a slug
  return slugWorkspace(workspace);
}

function buildModel(cfg: ResolvedLlmConfig): any {
  const providerSettings = { apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) };
  switch (cfg.protocol) {
    case 'anthropic-messages':
      return createAnthropic(providerSettings)(cfg.model);
    case 'openai-responses':
      // AI SDK v4 openai provider defaults to the responses API; explicit chat
      // would need compatibility(...) — we keep responses as the named protocol.
      return createOpenAI(providerSettings)(cfg.model);
    case 'openai-completions':
    default:
      return createOpenAI(providerSettings)(cfg.model);
  }
}

/**
 * Resolve the model instance for a session via the unified cascade (ADR-0016):
 * `session.config.model` override ?? `general.model` ?? dynamic default (first
 * usable provider's first model). Builds the SDK model. Throws when no model
 * resolves (empty registry / no general) — callers surface the picker.
 */
export async function getSessionModel(
  workspace: string,
  sessionId: string | undefined,
): Promise<{ model: any; protocol: ProviderProtocol }> {
  const settings = await loadSettings();
  const providers = mergedProviders(settings);
  const overrides = sessionId
    ? await new SessionStore({ workspace: workspaceToSlug(workspace), sessionId }).loadConfig()
    : {};
  const resolved = resolveSessionConfig(
    overrides,
    settings.general,
    providers,
  );
  const pc = providers[resolved.model.providerId];
  const secrets = await loadDotenv();
  const apiKey = resolveApiKey(pc.apiKeyRef, secrets);
  const cfg: ResolvedLlmConfig = {
    provider: pc.displayName,
    protocol: pc.protocol,
    model: resolved.model.modelId,
    apiKey,
    baseURL: pc.baseURL,
    reasoningLevel: resolved.reasoningLevel,
  };
  return { model: buildModel(cfg), protocol: pc.protocol };
}

const APPLEPI_DIR = () => path.join(os.homedir(), '.applepi');

/**
 * Providers for the settings UI (ADR-0014). Returns:
 *  - `user`: every provider persisted in settings.json (a user-enabled or
 *    overridden builtin, or a custom provider) — i.e. the ones already shown.
 *  - `availableBuiltins`: builtin presets the user has NOT yet enabled (for the
 *    "add provider" picker). Only enabled builtins appear in `user`, so the UI
 *    shows a provider only once it has been filled in / added.
 *  - `lastUsedModel`: global default model.
 *  - `lastUsedLevel`: global default reasoning level.
 */
export async function getProviders(): Promise<{
  user: Record<string, ProviderConfig>;
  availableBuiltins: { id: string; displayName: string }[];
  lastUsedModel?: { providerId: string; modelId: string };
  lastUsedLevel?: ReasoningLevel;
  defaultPermissionLevel?: PermissionLevel;
}> {
  const settings = await loadSettings().catch(() => ({ providers: {} } as any));
  const user: Record<string, ProviderConfig> = {};
  for (const [id, pc] of Object.entries(settings.providers)) {
    user[id] = pc as ProviderConfig;
  }
  const availableBuiltins = Object.entries(BUILTIN_PROVIDERS)
    .filter(([id]) => !(id in user))
    .map(([id, p]) => ({ id, displayName: p.displayName }));
  // Client-facing keys stay `lastUsedModel`/`lastUsedLevel`; they now source
  // from the `general` block (ADR-0016) instead of top-level legacy fields.
  return {
    user,
    availableBuiltins,
    lastUsedModel: settings.general?.model,
    lastUsedLevel: settings.general?.reasoningLevel,
    defaultPermissionLevel: settings.general?.permissionLevel,
  };
}

/** The current global default slots (ADR-0016), for the 设置-通用设置 page. */
export async function getGeneralDefaults(): Promise<GeneralConfig> {
  const settings = await loadSettings().catch(() => ({ general: undefined } as any));
  return settings.general ?? {};
}

/**
 * Persist the global default slots (ADR-0016 通用设置): model / reasoningLevel /
 * permissionLevel. Only the settings page writes these — the composer chip and
 * permission capsule write session overrides, never the global defaults.
 */
export async function saveGeneralDefaults(body: {
  model?: { providerId: string; modelId: string };
  reasoningLevel?: string;
  permissionLevel?: string;
}): Promise<void> {
  if (body.reasoningLevel !== undefined && !(REASONING_LEVELS as readonly string[]).includes(body.reasoningLevel)) {
    throw new Error(`reasoningLevel must be one of: ${REASONING_LEVELS.join('|')}`);
  }
  if (body.permissionLevel !== undefined && !(PERMISSION_LEVELS as readonly string[]).includes(body.permissionLevel)) {
    throw new Error(`permissionLevel must be one of: ${PERMISSION_LEVELS.join('|')}`);
  }
  if (body.model !== undefined && (typeof body.model.providerId !== 'string' || typeof body.model.modelId !== 'string')) {
    throw new Error('model requires providerId + modelId');
  }
  const settings = await loadSettings();
  settings.general = {
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.reasoningLevel !== undefined
      ? { reasoningLevel: body.reasoningLevel as ReasoningLevel }
      : {}),
    ...(body.permissionLevel !== undefined
      ? { permissionLevel: body.permissionLevel as PermissionLevel }
      : {}),
  };
  await saveSettings(settings);
}

/**
 * Persist provider config. Writes settings.json (ref-only) and, for any
 * provider whose body carries a real key (apiKeyRef === derived name AND a
 * `apiKey` field present), writes the real key into .env. Then invalidates
 * the cached model.
 */
export async function saveProviders(payload: {
  providers: Record<string, ProviderConfig & { apiKey?: string }>;
  lastUsedModel?: { providerId: string; modelId: string };
}): Promise<void> {
  const secrets = await loadDotenv();
  // The payload is the full desired provider set (the UI sends every enabled
  // provider). Anything absent from it is deleted — do NOT merge with the
  // existing settings, or removed providers would silently reappear.
  const out: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(payload.providers)) {
    const ref = p.apiKeyRef || providerSecretName(id);
    // Real key supplied in this save → write to .env under the derived name.
    if (typeof p.apiKey === 'string' && p.apiKey) {
      await writeDotenvKey(ref, p.apiKey);
    }
    // Persist to settings.json. For a builtin preset, store ONLY the user
    // overrides (typically just apiKeyRef / a custom model catalog); displayName,
    // protocol and baseURL fall back to the code preset at load time. A custom
    // provider keeps everything it declared.
    const { apiKey: _omit, ...rest } = p;
    if (id in BUILTIN_PROVIDERS) {
      // Minimal enabled entry: apiKeyRef (+ optional model catalog) only.
      // loadSettings back-fills displayName/protocol/baseURL from the preset,
      // so those fields are intentionally omitted here.
      const stored: Record<string, unknown> = { apiKeyRef: ref };
      if (Array.isArray(rest.models) && rest.models.length) stored.models = rest.models;
      out[id] = stored as unknown as ProviderConfig;
    } else {
      out[id] = { ...rest, apiKeyRef: ref };
    }
  }
  // The client sends `lastUsedModel`; store it under the `general` block
  // (ADR-0016) as the global default model.
  await saveSettings({
    providers: out,
    ...(payload.lastUsedModel ? { general: { model: payload.lastUsedModel } } : {}),
  });
}

/** Fetch available models from an openai-compatible /models endpoint (Q7). */
export async function listModels(providerId: string): Promise<ModelEntry[]> {
  const settings = await loadSettings().catch(() => ({ providers: {} } as any));
  const pc: ProviderConfig | undefined = settings.providers[providerId] ?? BUILTIN_PROVIDERS[providerId];
  if (!pc) {
    const err = new Error(`provider not found: ${providerId}`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  if (pc.protocol === 'anthropic-messages') {
    throw new Error('anthropic-messages 协议不提供模型列表端点，请手动添加模型');
  }
  const base = pc.baseURL || 'https://api.openai.com/v1';
  const secrets = await loadDotenv();
  const apiKey = secrets[pc.apiKeyRef] || pc.apiKeyRef;
  const res = await fetch(`${base.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`获取模型失败: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const ids: string[] = (json.data || [])
    .map((m: any) => m.id as string)
    .filter(Boolean)
    .sort();
  return ids.map((id) => ({ id, displayName: id }));
}

/** Persist the global default model (settings.json.general.model, ADR-0016). */
export async function saveLastUsed(providerId: string, modelId: string): Promise<void> {
  const settings = await loadSettings();
  settings.general = { ...settings.general, model: { providerId, modelId } };
  await saveSettings(settings);
}

/** Persist the global default reasoning level (settings.json.general.reasoningLevel). */
export async function saveLastUsedLevel(level: ReasoningLevel): Promise<void> {
  if (!(REASONING_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`level must be one of: ${REASONING_LEVELS.join('|')}`);
  }
  const settings = await loadSettings();
  settings.general = { ...settings.general, reasoningLevel: level };
  await saveSettings(settings);
}

/**
 * Resolve the effective reasoning level for a session via the unified cascade
 * (ADR-0016): `session.config.reasoningLevel` override ?? `general.reasoningLevel`
 * ?? DEFAULT_REASONING_LEVEL. Reads the persisted config file + settings general.
 */
export async function sessionReasoningLevel(
  workspace: string,
  sessionId: string,
): Promise<ReasoningLevel> {
  const store = new SessionStore({ workspace: workspaceToSlug(workspace), sessionId });
  const overrides = await store.loadConfig();
  const settings = await loadSettings().catch(() => ({ providers: {}, general: undefined } as any));
  return resolveSessionConfig(
    { reasoningLevel: overrides.reasoningLevel },
    settings.general,
    mergedProviders(settings),
  ).reasoningLevel;
}

/** Whether the "open config file" action is available on this platform (Q4/Q9). */
export function configFileHidden(): boolean {
  return process.platform !== 'darwin' && process.platform !== 'linux';
}

/** Open settings.json in the OS default editor (Q4/Q9); non-desktop → hidden. */
export async function openConfigFile(): Promise<{ hidden: boolean }> {
  if (configFileHidden()) return { hidden: true };
  const file = path.join(APPLEPI_DIR(), 'settings.json');
  const cmd = process.platform === 'darwin' ? `open "${file}"` : `xdg-open "${file}"`;
  try {
    await execAsync(cmd, { timeout: 10000 });
    return { hidden: false };
  } catch {
    return { hidden: true };
  }
}

const harnessCache = new Map<string, Harness>();

/**
 * One wired Harness per (workspace, mode) pair, cached for the server's
 * lifetime. The tool registry is determined by the session's bundle/mode,
 * which is immutable per session (ADR-0015: chosen once at creation).
 */
export function getHarness(workspace: string, mode: string): Harness {
  const slug = workspaceToSlug(workspace);
  const key = `${slug}:${mode}`;
  let h = harnessCache.get(key);
  if (!h) {
    h = new Harness({ workspace: slug });
    const spec = makeBundleSpec(mode, { cwd: process.cwd() });
    if (!spec) throw new Error(`unknown mode: ${mode}`);
    // Enable the bundle's tools + its declared capabilities' tools (memory /
    // skills) via the @applepi/extensions capability registry.
    enableBundleSpec(h, spec);
    harnessCache.set(key, h);
  }
  return h;
}

/**
 * The mode a session runs under: the persisted `session.config.mode` identity,
 * else 'standard' (ADR-0015: mode is build-time, immutable; resume re-reads it
 * to rebuild the matching spec). Sessions created before modes existed default
 * to 'standard' (the old base+memory+skills behavior).
 */
export async function sessionMode(workspace: string, sessionId: string): Promise<string> {
  const store = new SessionStore({ workspace: workspaceToSlug(workspace), sessionId });
  const config = await store.loadConfig();
  return config.mode === 'base' ? 'base' : 'standard';
}

/**
 * The web app-interface fragments (ADR-0015 app layer): working-directory
 * guidance, overlaid between the bundle fragments and any plugin tail.
 */
function appInterface(harness: Harness): string[] {
  const root = harness.session.config.workspace ?? process.cwd();
  return [
    'You are running in the applepi web app. Use the selected workspace as the working directory for file operations.',
    `Workspace: ${root}`,
  ];
}

/** Assemble the flat system prompt for the session's mode at the current level. */
export function buildSystemPrompt(harness: Harness): string {
  const mode = (harness.session.config.mode as string) ?? 'standard';
  const spec = makeBundleSpec(mode, bundleEnv(harness));
  if (!spec) throw new Error(`unknown mode: ${mode}`);
  return assembleFlatPrompt(harness, spec, { app: appInterface(harness) });
}

/**
 * Point the harness at a session (resume existing or create new), record its
 * mode, and restore its permission level. Sets `session.config.workspace` so
 * the reference tools scope to the selected workspace. The initial system
 * message is NOT persisted here — callers doing brand-new-session setup (the
 * chat route, after applying pre-chosen level/reasoning) persist it.
 */
export async function bindSession(
  harness: Harness,
  workspace: string,
  sessionId?: string,
  mode: string = 'standard',
): Promise<SessionStore> {
  const slug = workspaceToSlug(workspace);
  // Tool working root: prefer the real path; resolve bare slugs (stale
  // localStorage) to the on-disk path so bash/str_replace get a valid cwd.
  let toolRoot = workspace;
  if (!workspace.includes('/') && !workspace.includes('\\')) {
    toolRoot = (await unslugWorkspace(workspace)) ?? workspace;
  }

  // Ensure the workspace is discoverable: server-side discovery is
  // manifest-only (ADR-0013). Register absolute-path workspaces that aren't
  // yet in the manifest so the sidebar / session history surface them even
  // when the client neglected to (e.g. the native "open local folder" picker
  // before the client-side registration fix, or a stale localStorage entry).
  if (path.isAbsolute(workspace)) {
    const manifest = await readManifest();
    if (!(slug in manifest)) {
      try {
        await addWorkspace(workspace);
      } catch {
        // best-effort: a non-directory or unreadable path just won't appear
        // in the sidebar; the turn can still proceed.
      }
    }
  }

  let store: SessionStore;
  if (sessionId) {
    // Resume: harness.resume() reloads the persisted identity (workspace/mode)
    // into session.config from the config file (ADR-0016).
    store = await harness.resume(sessionId);
  } else {
    store = new SessionStore({ workspace: slug });
    await store.create();
    harness.sessionStore = store;
    harness.session.history = [];
    // Brand-new session: write the build-time identity once into the config
    // file (ADR-0016) — workspace (absolute, self-contained) + mode. Resume
    // re-reads this file, not an event.
    harness.session.config = { workspace: toolRoot, mode };
    await store.saveConfig(harness.session.config);
  }
  await harness.restoreSecurity(store);
  return store;
}

/** system prompt (fresh flat assembly, current level) + session history. */
export async function buildTurnMessages(harness: Harness): Promise<any[]> {
  return [{ role: 'system', content: buildSystemPrompt(harness) }, ...harness.session.history];
}

/**
 * Manifest entry. Backward compatible: old entries are plain path strings;
 * new entries are objects so a display name override (rename) can be stored
 * without touching the on-disk directory.
 */
export type ManifestEntry = string | { path: string; name?: string };

/** Normalize a manifest entry to its absolute path. */
export function entryPath(e: ManifestEntry): string {
  return typeof e === 'string' ? e : e.path;
}
/** Optional display-name override for a manifest entry. */
export function entryName(e: ManifestEntry): string | undefined {
  return typeof e === 'string' ? undefined : e.name;
}

/** Read the slug -> path manifest (best effort). */
export async function readManifest(): Promise<Record<string, ManifestEntry>> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

export interface SessionInfo {
  id: string;
  /** Last `title/set` event, else the first user message (truncated). */
  title: string;
  /** File mtime (ISO). */
  ts: string;
  /** Last `pin/set` event payload (default false). */
  pinned: boolean;
  /** Last `notify/set` event payload (default false). */
  notify: boolean;
}

export interface WorkspaceInfo {
  slug: string;
  path?: string;
  /** Display name: last path segment (basename), e.g. `applepi`. */
  name?: string;
  sessions: SessionInfo[];
}

/**
 * Derive a session's display title: last `title/set` event wins, else the
 * first user message text (truncated), else "New Chat". Delegates to the core
 * `SessionStore.title` primitive (deepen #02) — no server-side jsonl parsing.
 */
export async function sessionTitle(
  workspace: string,
  id: string,
): Promise<string> {
  return new SessionStore({ workspace, sessionId: id }).title();
}

/** Read `pin/set` (last wins) via the core primitive (deepen #02). */
export async function sessionPinned(workspace: string, id: string): Promise<boolean> {
  return new SessionStore({ workspace, sessionId: id }).pinned();
}

/** Read `notify/set` (last wins) via the core primitive (deepen #02). */
export async function sessionNotify(workspace: string, id: string): Promise<boolean> {
  return new SessionStore({ workspace, sessionId: id }).notify();
}

/**
 * List existing workspaces. Discovery is **manifest-only**: we read the
 * slug→path entries from `~/.applepi/sessions/.manifest.json` (written by
 * `addWorkspace` and the CLI) instead of scanning the sessions dir for every
 * subdirectory. This keeps stale / test directories (e.g. `test-ws-*`) out of
 * the UI. Each manifest entry still resolves its sessions by slug; sessions
 * without a recorded path are skipped. The display name is the path basename.
 * Session rows come from the core `SessionStore.listSessions` primitive
 * (deepen #02) — no server-side jsonl parses.
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const manifest = await readManifest();
  const slugs = Object.keys(manifest).sort();
  const out: WorkspaceInfo[] = [];
  for (const slug of slugs) {
    const entry = manifest[slug];
    if (!entry) continue; // manifest entries are always path-backed
    const wsPath = entryPath(entry);
    const nameOverride = entryName(entry);
    const store = new SessionStore({ workspace: slug });
    const sessions = await store.listSessions();
    out.push({ slug, path: wsPath, name: nameOverride ?? path.basename(wsPath), sessions });
  }
  return out;
}

/** Add a workspace by absolute path (validated); records it in the manifest. */
export async function addWorkspace(p: string): Promise<{ slug: string; path: string }> {
  const abs = path.resolve(p);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`workspace path does not exist or is not a directory: ${abs}`);
  }
  const slug = slugWorkspace(abs);
  await fs.mkdir(path.join(SESSIONS_DIR(), slug), { recursive: true });
  const manifest = await readManifest();
  manifest[slug] = { path: abs };
  await fs.writeFile(MANIFEST_FILE(), JSON.stringify(manifest, null, 2), 'utf8');
  return { slug, path: abs };
}

/**
 * Rename a workspace's display label. Stores a `name` override in the manifest
 * (does NOT rename the on-disk directory). An empty name clears the override so
 * the display falls back to the path basename.
 */
export async function renameWorkspace(slug: string, name: string): Promise<void> {
  const manifest = await readManifest();
  const existing = manifest[slug];
  if (!existing) throw new Error(`workspace not found: ${slug}`);
  const trimmed = name.trim().slice(0, 80);
  manifest[slug] = { path: entryPath(existing), name: trimmed || undefined };
  await fs.writeFile(MANIFEST_FILE(), JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Remove a workspace from the UI (logical delete). Drops the manifest entry so
 * `listWorkspaces` no longer returns it, but leaves every session file on disk
 * untouched — re-adding the same path restores it.
 */
export async function removeWorkspace(slug: string): Promise<void> {
  const manifest = await readManifest();
  if (!(slug in manifest)) throw new Error(`workspace not found: ${slug}`);
  delete manifest[slug];
  await fs.writeFile(MANIFEST_FILE(), JSON.stringify(manifest, null, 2), 'utf8');
}

export interface SessionActionRequest {
  action: 'rename' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'notify' | 'level' | 'reasoning' | 'model';
  title?: string;
  pinned?: boolean;
  enabled?: boolean;
  level?: string;
  reasoning?: string;
  model?: { providerId: string; modelId: string };
}

const ARCHIVE_DIR = (slug: string) => path.join(SESSIONS_DIR(), slug, '.archive');

/**
 * Apply a session action. Most are lightweight event writes (rename/pin/
 * notify) or file moves (archive/unarchive); `level`/`reasoning`/`model`
 * persist session-config overrides (ADR-0016, <id>.config.json).
 */
export async function applySessionAction(
  workspace: string,
  sessionId: string,
  req: SessionActionRequest,
): Promise<{ ok: true }> {
  const slug = workspaceToSlug(workspace);
  const store = new SessionStore({ workspace: slug, sessionId });

  switch (req.action) {
    case 'rename': {
      const title = String(req.title ?? '').trim().slice(0, 80);
      if (!title) throw new Error('rename requires a title');
      await store.create(sessionId);
      await store.appendEvent('title/set', { title });
      return { ok: true };
    }
    case 'pin':
      await store.create(sessionId);
      await store.appendEvent('pin/set', { pinned: true });
      return { ok: true };
    case 'unpin':
      await store.create(sessionId);
      await store.appendEvent('pin/set', { pinned: false });
      return { ok: true };
    case 'notify':
      await store.create(sessionId);
      await store.appendEvent('notify/set', { enabled: req.enabled === true });
      return { ok: true };
    case 'archive': {
      await fs.mkdir(ARCHIVE_DIR(slug), { recursive: true });
      await fs.rename(
        path.join(SESSIONS_DIR(), slug, `${sessionId}.jsonl`),
        path.join(ARCHIVE_DIR(slug), `${sessionId}.jsonl`),
      );
      return { ok: true };
    }
    case 'unarchive': {
      const src = path.join(ARCHIVE_DIR(slug), `${sessionId}.jsonl`);
      const st = await fs.stat(src).catch(() => null);
      if (!st) throw new Error(`archived session not found: ${sessionId}`);
      await fs.rename(src, path.join(SESSIONS_DIR(), slug, `${sessionId}.jsonl`));
      return { ok: true };
    }
    case 'level': {
      const level = String(req.level ?? '');
      if (!(PERMISSION_LEVELS as readonly string[]).includes(level as any)) {
        throw new Error(`level must be one of: ${PERMISSION_LEVELS.join('|')}`);
      }
      const mode = await sessionMode(workspace, sessionId);
      const harness = getHarness(workspace, mode);
      const bound = await bindSession(harness, workspace, sessionId, mode);
      await applyPermissionLevel(harness.session, bound, level);
      return { ok: true };
    }
    case 'reasoning': {
      const reasoning = String(req.reasoning ?? '');
      if (!(REASONING_LEVELS as readonly string[]).includes(reasoning as any)) {
        throw new Error(`reasoning must be one of: ${REASONING_LEVELS.join('|')}`);
      }
      const store = new SessionStore({ workspace: workspaceToSlug(workspace), sessionId });
      await store.create(sessionId);
      const overrides = await store.loadConfig();
      await store.saveConfig({ ...overrides, reasoningLevel: reasoning as ReasoningLevel });
      return { ok: true };
    }
    case 'model': {
      const m = req.model;
      if (!m || typeof m.providerId !== 'string' || typeof m.modelId !== 'string') {
        throw new Error('model requires providerId + modelId');
      }
      const store = new SessionStore({ workspace: workspaceToSlug(workspace), sessionId });
      await store.create(sessionId);
      const overrides = await store.loadConfig();
      await store.saveConfig({ ...overrides, model: { providerId: m.providerId, modelId: m.modelId } });
      return { ok: true };
    }
    default:
      throw new Error(`unknown session action: ${(req as any).action}`);
  }
}

/** Raw session file contents (export). */
export async function readSessionFile(
  workspace: string,
  sessionId: string,
): Promise<string> {
  const slug = workspaceToSlug(workspace);
  const store = new SessionStore({ workspace: slug, sessionId });
  return fs.readFile(store.filePath(), 'utf8');
}

const execAsync = promisify(exec);

/**
 * Native folder picker (macOS only): opens the system directory chooser via
 * osascript and returns the REAL absolute path. The browser's
 * showDirectoryPicker only yields an opaque handle — useless for a workspace
 * the tools must run in — so we pick server-side.
 */
export async function pickFolder(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('打开本地文件夹仅支持 macOS（当前平台: ' + process.platform + '）');
  }
  const { stdout } = await execAsync(
    `osascript -e 'POSIX path of (choose folder)'`,
    { timeout: 120000 },
  );
  const p = (stdout ?? '').trim();
  if (!p) throw new Error('未选择文件夹');
  return p;
}
