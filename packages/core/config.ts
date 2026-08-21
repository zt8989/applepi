import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * LLM configuration — multi-provider registry (ADR-0014 extended by ADR-0016).
 * Two files under ~/.applepi/:
 *  - settings.json — the only source of LLM config: `{ providers, general? }`
 *  - .env          — secret file holding real API key values (one per provider)
 *
 * `general` (ADR-0016) holds the global default slots for the session-overridable
 * keys (model / reasoningLevel / permissionLevel); the cascade is
 * `会话覆盖 ?? general ?? builtin`. The old top-level `lastUsedModel` /
 * `lastUsedLevel` fields are gone — no compatible read (ADR-0016).
 *
 * A provider's `apiKeyRef` is a *reference* (a name into .env); the value
 * itself is used when the lookup misses. The legacy `provider` string is now a
 * display/grouping label only — the SDK factory is selected by `protocol`.
 */

export type ProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const;

/**
 * Permission level — the three-value security level (ADR-0009). Lives here (not
 * in security.ts) so `config` can own the `general.permissionLevel` slot and
 * `resolveSessionConfig` cascade without a config↔security import cycle. The
 * security module imports these and owns the enforcement semantics.
 */
export const PERMISSION_LEVELS = ['readonly', 'workspace', 'fullaccess'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace';

/**
 * Reasoning level — how much thinking effort the LLM applies. Orthogonal to
 * the permission level (which governs tool/security boundaries): this only
 * tunes the model request. `off` sends no reasoning parameter; `low/medium/
 * high` map to provider-specific params (see stream-loop.ts). Global default in
 * `settings.json.general.reasoningLevel` + per-session override in
 * `session.config.reasoningLevel` (ADR-0016).
 */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  'off',
  'low',
  'medium',
  'high',
] as const;

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'medium';

export interface ModelEntry {
  id: string;
  displayName: string;
}

export interface ProviderConfig {
  /** Human display name (also the model-selector group header). */
  displayName: string;
  /** Selects the SDK factory — the runtime discriminant. */
  protocol: ProviderProtocol;
  /** Optional base URL override (mapped to the SDK provider's `baseURL`). */
  baseURL?: string;
  /** Name into ~/.applepi/.env holding the real key (derived: PROVIDER_<ID_UPPER>_API_KEY). */
  apiKeyRef: string;
  /** Optional managed catalog; non-empty populates the selector. */
  models?: ModelEntry[];
  /** true = builtin preset (not user-deletable). Absent/undefined = user provider. */
  builtin?: boolean;
}

/**
 * Global default slots for the session-overridable keys (ADR-0016). These are
 * the only place a global default lives; each is overridable per-session via
 * `session.config`, and the model's builtin default tier is computed at read.
 */
export interface GeneralConfig {
  /** Global default model (providerId + modelId). */
  model?: { providerId: string; modelId: string };
  /** Global default reasoning level; session override ?? this ?? medium. */
  reasoningLevel?: ReasoningLevel;
  /** Global default permission level; session override ?? this ?? workspace. */
  permissionLevel?: PermissionLevel;
}

export interface LlmSettings {
  providers: Record<string, ProviderConfig>;
  /** Global default slots (ADR-0016); set via 设置-通用设置, not by session actions. */
  general?: GeneralConfig;
}

export interface ResolvedLlmConfig {
  /** Display/grouping label only (legacy `provider` string). */
  provider: string;
  /** Selects the SDK factory. */
  protocol: ProviderProtocol;
  model: string;
  apiKey: string;
  /** Optional base URL override, forwarded to the provider factory. */
  baseURL?: string;
  /** Global default reasoning level (resolved; per-session override applied upstream). */
  reasoningLevel: ReasoningLevel;
}

/** Builtin read-only provider presets (ADR-0014). */
export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    displayName: 'DeepSeek',
    protocol: 'openai-completions',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyRef: 'PROVIDER_DEEPSEEK_API_KEY',
    builtin: true,
  },
  openai: {
    displayName: 'OpenAI',
    protocol: 'openai-completions',
    apiKeyRef: 'PROVIDER_OPENAI_API_KEY',
    builtin: true,
  },
  anthropic: {
    displayName: 'Anthropic',
    protocol: 'anthropic-messages',
    apiKeyRef: 'PROVIDER_ANTHROPIC_API_KEY',
    builtin: true,
  },
  gemini: {
    displayName: 'Gemini',
    protocol: 'openai-completions',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyRef: 'PROVIDER_GEMINI_API_KEY',
    builtin: true,
  },
  mistral: {
    displayName: 'Mistral',
    protocol: 'openai-completions',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyRef: 'PROVIDER_MISTRAL_API_KEY',
    builtin: true,
  },
  zhipu: {
    displayName: '智谱 GLM',
    protocol: 'openai-completions',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyRef: 'PROVIDER_ZHIPU_API_KEY',
    builtin: true,
  },
  qwen: {
    displayName: '通义千问',
    protocol: 'openai-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyRef: 'PROVIDER_QWEN_API_KEY',
    builtin: true,
  },
};

/** Default catalog hint for providers without a user-supplied catalog. */
const DEFAULT_CATALOG: Record<string, ModelEntry[]> = {
  deepseek: [
    { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
  ],
  openai: [
    { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
    { id: 'gpt-4o', displayName: 'GPT-4o' },
    { id: 'gpt-4-turbo', displayName: 'GPT-4 Turbo' },
  ],
  anthropic: [
    { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-latest', displayName: 'Claude 3 Opus' },
  ],
  gemini: [{ id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }],
  mistral: [{ id: 'mistral-large-latest', displayName: 'Mistral Large' }],
  zhipu: [{ id: 'glm-4-plus', displayName: 'GLM-4-Plus' }],
  qwen: [{ id: 'qwen-max', displayName: 'Qwen Max' }],
};

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.applepi');
}

function settingsFile(baseDir: string = defaultBaseDir()): string {
  return path.join(baseDir, 'settings.json');
}

/**
 * Read settings.json. Supports the multi-provider registry + `general` block
 * (ADR-0014/0016): `{ providers, general? }`. Missing file → throw (fail fast);
 * malformed JSON → throw. The old top-level `lastUsedModel`/`lastUsedLevel` are
 * ignored (no compatible read, ADR-0016). (No legacy flat-shape migration in
 * code — see ADR-0014.)
 */
export async function loadSettings(baseDir: string = defaultBaseDir()): Promise<LlmSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsFile(baseDir), 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new Error(
        `~/.applepi/settings.json not found (looked at ${settingsFile(baseDir)}). ` +
          `Create it with a provider registry, e.g. ` +
          `{ "providers": { "openai": { "displayName": "OpenAI", "protocol": "openai-completions", "apiKeyRef": "PROVIDER_OPENAI_API_KEY" } }, "general": { "model": { "providerId": "openai", "modelId": "gpt-4o-mini" } } }; ` +
          `real keys go in ~/.applepi/.env (ADR-0004/0014/0016).`,
      );
    }
    throw e;
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`~/.applepi/settings.json is not valid JSON: ${e?.message}`);
  }
  if (!data || typeof data !== 'object' || typeof data.providers !== 'object' || data.providers === null) {
    throw new Error(
      `~/.applepi/settings.json must be a provider registry: { "providers": {...}, "general"?: {...} }`,
    );
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(data.providers)) {
    const pc = p as any;
    if (!pc || typeof pc !== 'object') {
      throw new Error(`provider "${id}" must be an object`);
    }
    const preset = BUILTIN_PROVIDERS[id];

    // A builtin-enabled entry may omit displayName/protocol/baseURL/models:
    // missing fields fall back to the code preset (ADR-0014). Only a custom
    // provider (no preset) must declare an explicit protocol.
    if (!preset && typeof pc.protocol !== 'string') {
      throw new Error(`provider "${id}" is missing a "protocol" field`);
    }
    if (typeof pc.protocol === 'string' && !PROVIDER_PROTOCOLS.includes(pc.protocol)) {
      throw new Error(
        `provider "${id}" has unsupported protocol "${pc.protocol}" (supported: ${PROVIDER_PROTOCOLS.join(', ')})`,
      );
    }
    const models = Array.isArray(pc.models)
      ? pc.models.map((m: any) => ({ id: String(m.id), displayName: String(m.displayName ?? m.id) }))
      : undefined;
    // Merge: preset (if any) is the base; the user entry overrides only fields
    // it explicitly provides. displayName defaults to the id when absent.
    const base = preset ?? ({} as ProviderConfig);
    providers[id] = {
      displayName:
        typeof pc.displayName === 'string' && pc.displayName
          ? pc.displayName
          : (base.displayName ?? id),
      protocol: (typeof pc.protocol === 'string' ? pc.protocol : base.protocol) as ProviderProtocol,
      baseURL: typeof pc.baseURL === 'string' && pc.baseURL ? pc.baseURL : base.baseURL,
      apiKeyRef:
        typeof pc.apiKeyRef === 'string' && pc.apiKeyRef
          ? pc.apiKeyRef
          : (base.apiKeyRef ?? `PROVIDER_${id.toUpperCase()}_API_KEY`),
      models: models && models.length ? models : base.models ?? DEFAULT_CATALOG[id],
      builtin: preset ? true : pc.builtin === true,
    };
  }
  // `general` block (ADR-0016): global default slots for model/reasoningLevel/
  // permissionLevel. Values are validated; invalid/absent → that slot omitted
  // (falls through to the builtin default at cascade time).
  let general: GeneralConfig | undefined;
  if (data.general && typeof data.general === 'object') {
    const g = data.general;
    const model =
      g.model && typeof g.model.providerId === 'string' && typeof g.model.modelId === 'string'
        ? { providerId: g.model.providerId, modelId: g.model.modelId }
        : undefined;
    const reasoningLevel =
      typeof g.reasoningLevel === 'string' && (REASONING_LEVELS as readonly string[]).includes(g.reasoningLevel)
        ? (g.reasoningLevel as ReasoningLevel)
        : undefined;
    const permissionLevel =
      typeof g.permissionLevel === 'string' &&
      (PERMISSION_LEVELS as readonly string[]).includes(g.permissionLevel)
        ? (g.permissionLevel as PermissionLevel)
        : undefined;
    if (model || reasoningLevel || permissionLevel) {
      general = {
        ...(model ? { model } : {}),
        ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
        ...(permissionLevel !== undefined ? { permissionLevel } : {}),
      };
    }
  }
  return { providers, ...(general ? { general } : {}) };
}

/** Write settings.json (atomic-ish: full rewrite). */
export async function saveSettings(settings: LlmSettings, baseDir: string = defaultBaseDir()): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(settingsFile(baseDir), JSON.stringify(settings, null, 2), 'utf8');
}

/** Read .env via dotenv.parse (pure — never writes process.env); missing → {}. */
export async function loadDotenv(baseDir: string = defaultBaseDir()): Promise<Record<string, string>> {
  const file = path.join(baseDir, '.env');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return {};
  }
  return dotenv.parse(raw) as Record<string, string>;
}

/** Write/update one key in .env (preserves other keys; safe best-effort). */
export async function writeDotenvKey(
  key: string,
  value: string,
  baseDir: string = defaultBaseDir(),
): Promise<void> {
  const file = path.join(baseDir, '.env');
  let env: Record<string, string> = {};
  try {
    env = dotenv.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // missing .env → start fresh
  }
  env[key] = value;
  const out = Object.entries(env)
    .map(([k, v]) => `${k}=${v.includes('\n') || v.includes('"') || v.includes(' ') ? JSON.stringify(v) : v}`)
    .join('\n');
  await fs.writeFile(file, out + '\n', 'utf8');
}

/** Lookup-by-name: treat apiKeyRef as a key into secrets; miss → use the ref itself. */
export function resolveApiKey(apiKeyRef: string, secrets: Record<string, string>): string {
  return secrets[apiKeyRef] ?? apiKeyRef;
}

/** Derive the .env secret name for a provider id. */
export function providerSecretName(providerId: string): string {
  return `PROVIDER_${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Usable providers = user providers ∪ builtin presets (user entries win on name
 * clash). Builtin presets are code-defined and need not appear in settings.json
 * (ADR-0014): a default/general model may point at a builtin alone.
 *
 * A pure builtin preset (not listed in settings.json) has no `models` catalog
 * of its own — loadSettings fills it from DEFAULT_CATALOG only when the entry
 * is listed. Here we backfill the default catalog for any provider that lacks
 * `models`, so the model cascade's "first usable provider's first model" tier
 * (ADR-0016) can resolve against a builtin-only registry too.
 */
export function mergedProviders(settings: Pick<LlmSettings, 'providers'>): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = { ...BUILTIN_PROVIDERS, ...settings.providers };
  for (const id of Object.keys(merged)) {
    const pc = merged[id];
    if (!pc.models && DEFAULT_CATALOG[id]) {
      merged[id] = { ...pc, models: DEFAULT_CATALOG[id] };
    }
  }
  return merged;
}

/** Effective per-overridable-key config (ADR-0016): `覆盖 ?? general ?? builtin`. */
export interface ResolvedSessionConfig {
  /** Resolved model (providerId + modelId), computed at read. */
  model: { providerId: string; modelId: string };
  reasoningLevel: ReasoningLevel;
  permissionLevel: PermissionLevel;
}

/**
 * Model's default tier is **computed at read, never persisted** (ADR-0016):
 * session override → general.model → the first usable provider's first model.
 * The last tier re-derives automatically when the default's provider is deleted
 * or its catalog empties — no write-back repair path.
 */
function resolveModel(
  override: { providerId: string; modelId: string } | undefined,
  generalModel: { providerId: string; modelId: string } | undefined,
  providers: Record<string, ProviderConfig>,
): { providerId: string; modelId: string } {
  const pick = (m: { providerId: string; modelId: string } | undefined) =>
    m && m.providerId in providers ? m : undefined;
  const fromOverride = pick(override);
  if (fromOverride) return fromOverride;
  const fromGeneral = pick(generalModel);
  if (fromGeneral) return fromGeneral;
  for (const id of Object.keys(providers)) {
    const firstModel = providers[id].models?.[0]?.id;
    if (firstModel) return { providerId: id, modelId: firstModel };
  }
  throw new Error(
    'no usable model: configure "general.model" or a provider with a model catalog in ~/.applepi/settings.json',
  );
}

/**
 * The unified cascade (ADR-0016): `session.config override ?? general default
 * ?? builtin default`, as a pure function over config inputs (no I/O). Applies
 * to every session-overridable key. `model` resolves via cross-provider
 * fallback (see resolveModel); reasoning defaults to `medium`, permission to
 * `workspace`.
 */
export function resolveSessionConfig(
  overrides: { model?: { providerId: string; modelId: string }; reasoningLevel?: ReasoningLevel; permissionLevel?: PermissionLevel } | undefined,
  general: GeneralConfig | undefined,
  providers: Record<string, ProviderConfig>,
): ResolvedSessionConfig {
  const reasoningLevel = overrides?.reasoningLevel ?? general?.reasoningLevel ?? DEFAULT_REASONING_LEVEL;
  const permissionLevel = overrides?.permissionLevel ?? general?.permissionLevel ?? DEFAULT_PERMISSION_LEVEL;
  const model = resolveModel(overrides?.model, general?.model, providers);
  return { model, reasoningLevel, permissionLevel };
}

/**
 * One-shot: settings + secrets + resolution + validation (fail fast).
 * Resolves the *general default* provider+model (no global `active`, ADR-0014;
 * session overrides applied upstream by the caller via resolveSessionConfig).
 */
export async function resolveLlmConfig(baseDir: string = defaultBaseDir()): Promise<ResolvedLlmConfig> {
  const settings = await loadSettings(baseDir);
  const secrets = await loadDotenv(baseDir);
  const providers = mergedProviders(settings);

  const resolved = resolveSessionConfig(undefined, settings.general, providers);
  const pc = providers[resolved.model.providerId];

  const apiKey = resolveApiKey(pc.apiKeyRef, secrets);
  if (!apiKey) {
    throw new Error(
      `no usable apiKey for provider "${resolved.model.providerId}": add "${pc.apiKeyRef}=<your key>" to ~/.applepi/.env`,
    );
  }
  return {
    provider: pc.displayName,
    protocol: pc.protocol,
    model: resolved.model.modelId,
    apiKey,
    baseURL: pc.baseURL,
    reasoningLevel: resolved.reasoningLevel,
  };
}
