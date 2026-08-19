import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * LLM configuration (ADR-0004). Two files under ~/.applepi/:
 *  - settings.json — the only source of LLM config (provider / model / apiKey)
 *  - .env          — secret file holding real API key values
 * The `apiKey` field in settings.json is a *reference*: it is looked up by name
 * in the secret file, and the value itself is used when the lookup misses.
 */

export interface LlmSettings {
  provider: string;
  model: string;
  apiKey: string;
}

export const SUPPORTED_PROVIDERS = ['openai', 'anthropic'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
};

/** Default per provider: apiKey holds the canonical env var name (a reference). */
const DEFAULT_API_KEY_REFS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'OPENAI_API_KEY',
};

export interface ResolvedLlmConfig {
  provider: SupportedProvider;
  model: string;
  apiKey: string;
}

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.applepi');
}

/** Read settings.json; missing file → defaults; malformed JSON → throw. */
export async function loadSettings(baseDir: string = defaultBaseDir()): Promise<LlmSettings> {
  const file = path.join(baseDir, 'settings.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`~/.applepi/settings.json is not valid JSON: ${e?.message}`);
  }
  const provider =
    typeof data.provider === 'string' && data.provider
      ? data.provider
      : DEFAULT_LLM_SETTINGS.provider;
  const model =
    typeof data.model === 'string' && data.model
      ? data.model
      : (DEFAULT_PROVIDER_MODELS[provider] ?? DEFAULT_LLM_SETTINGS.model);
  const apiKey =
    // Present-but-empty string = explicitly "no key" -> kept empty so that
    // resolveLlmConfig fails fast (Q6=a). Absent/non-string -> default ref.
    typeof data.apiKey === 'string'
      ? data.apiKey
      : (DEFAULT_API_KEY_REFS[provider] ?? DEFAULT_LLM_SETTINGS.apiKey);
  return { provider, model, apiKey };
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

/** Lookup-by-name: treat apiKeyRef as a key into secrets; miss → use the ref itself. */
export function resolveApiKey(apiKeyRef: string, secrets: Record<string, string>): string {
  return secrets[apiKeyRef] ?? apiKeyRef;
}

/** One-shot: settings + secrets + resolution + validation (fail fast). */
export async function resolveLlmConfig(baseDir: string = defaultBaseDir()): Promise<ResolvedLlmConfig> {
  const settings = await loadSettings(baseDir);
  const secrets = await loadDotenv(baseDir);
  const apiKey = resolveApiKey(settings.apiKey, secrets);

  if (!SUPPORTED_PROVIDERS.includes(settings.provider as SupportedProvider)) {
    throw new Error(
      `unsupported LLM provider "${settings.provider}" in ~/.applepi/settings.json (supported: ${SUPPORTED_PROVIDERS.join(', ')})`,
    );
  }
  if (!apiKey) {
    const ref = settings.apiKey || DEFAULT_API_KEY_REFS[settings.provider] || 'OPENAI_API_KEY';
    throw new Error(
      `no usable apiKey for provider "${settings.provider}": set a real key in ~/.applepi/settings.json "apiKey", or add "${ref}=<your key>" to ~/.applepi/.env`,
    );
  }
  return {
    provider: settings.provider as SupportedProvider,
    model: settings.model,
    apiKey,
  };
}
