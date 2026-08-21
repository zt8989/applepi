import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * LLM configuration — multi-provider registry (ADR-0014, supersedes ADR-0004's
 * single-provider shape). Two files under ~/.applepi/:
 *  - settings.json — the only source of LLM config: `{ providers, lastUsedModel? }`
 *  - .env          — secret file holding real API key values (one per provider)
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
 * Reasoning level — how much thinking effort the LLM applies. Orthogonal to
 * the permission level (which governs tool/security boundaries): this only
 * tunes the model request. `off` sends no reasoning parameter; `low/medium/
 * high` map to provider-specific params (see stream-loop.ts). Stored as a
 * global default (`settings.json.lastUsedLevel`) + per-session override
 * (`reasoning/set` event).
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

export interface LlmSettings {
  providers: Record<string, ProviderConfig>;
  /** Global single record of the last-used model; pre-selected in the selector. */
  lastUsedModel?: { providerId: string; modelId: string };
  /** Global default reasoning level; per-session `reasoning/set` overrides it. */
  lastUsedLevel?: ReasoningLevel;
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
 * Read settings.json. Supports the multi-provider registry only (ADR-0014):
 * `{ providers, lastUsedModel? }`. Missing file → throw (fail fast);
 * malformed JSON → throw. (No legacy flat-shape migration in code — see ADR-0014.)
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
          `{ "providers": { "openai": { "displayName": "OpenAI", "protocol": "openai-completions", "apiKeyRef": "PROVIDER_OPENAI_API_KEY" } }, "lastUsedModel": { "providerId": "openai", "modelId": "gpt-4o-mini" } }; ` +
          `real keys go in ~/.applepi/.env (ADR-0004/0014).`,
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
      `~/.applepi/settings.json must be a provider registry: { "providers": {...}, "lastUsedModel"?: {...} }`,
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
  const lastUsedModel =
    data.lastUsedModel && typeof data.lastUsedModel.providerId === 'string' && typeof data.lastUsedModel.modelId === 'string'
      ? { providerId: data.lastUsedModel.providerId, modelId: data.lastUsedModel.modelId }
      : undefined;
  const lastUsedLevel =
    typeof data.lastUsedLevel === 'string' && (REASONING_LEVELS as readonly string[]).includes(data.lastUsedLevel)
      ? (data.lastUsedLevel as ReasoningLevel)
      : undefined;
  return { providers, lastUsedModel, ...(lastUsedLevel !== undefined ? { lastUsedLevel } : {}) };
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
 * One-shot: settings + secrets + resolution + validation (fail fast).
 * Resolves the *last-used* provider+model (no global `active`, ADR-0014).
 */
export async function resolveLlmConfig(baseDir: string = defaultBaseDir()): Promise<ResolvedLlmConfig> {
  const settings = await loadSettings(baseDir);
  const secrets = await loadDotenv(baseDir);

  // Usable providers = user providers ∪ builtin presets (user entries win on
  // name clash). Builtin presets are code-defined and need not appear in
  // settings.json (ADR-0014): a lastUsedModel may point at a builtin alone.
  const merged: Record<string, ProviderConfig> = { ...BUILTIN_PROVIDERS, ...settings.providers };

  const target = settings.lastUsedModel;
  let providerId: string | undefined = target?.providerId;
  let modelId: string | undefined = target?.modelId;

  if (!providerId || !(providerId in merged)) {
    // fall back to the first usable provider
    providerId = Object.keys(merged)[0];
    modelId = undefined;
  }
  if (!providerId) {
    throw new Error('no providers configured in ~/.applepi/settings.json');
  }
  const pc = merged[providerId];
  if (!modelId) {
    modelId = pc.models?.[0]?.id ?? '';
  }

  const apiKey = resolveApiKey(pc.apiKeyRef, secrets);
  if (!apiKey) {
    throw new Error(
      `no usable apiKey for provider "${providerId}": add "${pc.apiKeyRef}=<your key>" to ~/.applepi/.env`,
    );
  }
  return {
    provider: pc.displayName,
    protocol: pc.protocol,
    model: modelId,
    apiKey,
    baseURL: pc.baseURL,
    reasoningLevel: settings.lastUsedLevel ?? DEFAULT_REASONING_LEVEL,
  };
}
