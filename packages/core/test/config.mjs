// Plain-node unit test for the core LLM config primitives (ADR-0014 multi-provider
// registry + ADR-0016 general/cascade). No API key. Covers: loadSettings (missing
// -> throw / parse / invalid JSON / protocol validation / general block),
// loadDotenv (parse rules), resolveApiKey (lookup-by-name), resolveLlmConfig
// (placeholder+secret, direct key, fail-fast, model/general resolution, baseURL
// pass-through), resolveSessionConfig (override ?? general ?? builtin cascade,
// model dynamic default). All runs use a temp baseDir.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSettings,
  loadDotenv,
  resolveApiKey,
  resolveLlmConfig,
  resolveSessionConfig,
  mergedProviders,
  BUILTIN_PROVIDERS,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-config-test-'));
const settingsFile = path.join(base, 'settings.json');
const envFile = path.join(base, '.env');

/** Registry json: providers + optional general block (ADR-0016). */
function reg(providers, general) {
  return JSON.stringify({ providers, ...(general ? { general } : {}) });
}

/** A minimal non-empty merged provider map for cascade tests (builtin deepseek). */
const merged = mergedProviders({ providers: {} });


// 1. loadSettings: missing file -> throws (fail fast).
{
  await assert.rejects(() => loadSettings(base), /settings\.json not found/);
  ok('loadSettings: missing file -> throws (fail fast)');
}

// 2. loadSettings: valid registry parsed; provider label + default catalog.
{
  await fs.writeFile(
    settingsFile,
    reg({ anthropic: { displayName: 'Anthropic', protocol: 'anthropic-messages', apiKeyRef: 'PROVIDER_ANTHROPIC_API_KEY' } }),
  );
  const s = await loadSettings(base);
  assert.equal(s.providers.anthropic.displayName, 'Anthropic');
  assert.equal(s.providers.anthropic.protocol, 'anthropic-messages');
  ok('loadSettings: parses registry, protocol + displayName');
}

// 2b. loadSettings: a builtin-enabled entry may omit displayName/protocol/baseURL;
//     missing fields fall back to the code preset (ADR-0014 minimal-enabled form).
{
  await fs.writeFile(settingsFile, reg({ deepseek: { apiKeyRef: 'PROVIDER_DEEPSEEK_API_KEY' } }));
  const s = await loadSettings(base);
  assert.equal(s.providers.deepseek.displayName, 'DeepSeek', 'displayName from preset');
  assert.equal(s.providers.deepseek.protocol, 'openai-completions', 'protocol from preset');
  assert.equal(s.providers.deepseek.baseURL, 'https://api.deepseek.com/v1', 'baseURL from preset');
  assert.equal(s.providers.deepseek.apiKeyRef, 'PROVIDER_DEEPSEEK_API_KEY', 'explicit apiKeyRef kept');
  assert.equal(s.providers.deepseek.builtin, true, 'marked builtin');
  ok('loadSettings: minimal builtin entry falls back to preset for displayName/protocol/baseURL');
}

// 2c. loadSettings: a custom (non-builtin) provider still requires protocol.
{
  await fs.writeFile(settingsFile, reg({ acme: { apiKeyRef: 'PROVIDER_ACME_API_KEY' } }));
  await assert.rejects(() => loadSettings(base), /missing a "protocol" field/);
  ok('loadSettings: custom provider without protocol -> throws');
  await fs.unlink(settingsFile);
}

// 3. loadSettings: malformed JSON -> throws.
{
  await fs.writeFile(settingsFile, '{ not json');
  await assert.rejects(() => loadSettings(base), /not valid JSON/);
  ok('loadSettings: malformed JSON -> throw');
  await fs.unlink(settingsFile);
}

// 4. loadSettings: legacy flat shape (no `providers`) -> throws (no in-code migration, ADR-0014).
{
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }));
  await assert.rejects(() => loadSettings(base), /provider registry/);
  ok('loadSettings: legacy flat shape -> throws (migration is operator-run)');
  await fs.unlink(settingsFile);
}

// 5. loadSettings: unsupported protocol -> throws.
{
  await fs.writeFile(settingsFile, reg({ x: { displayName: 'X', protocol: 'groq', apiKeyRef: 'K' } }));
  await assert.rejects(() => loadSettings(base), /unsupported protocol/);
  ok('loadSettings: unsupported protocol -> throws');
  await fs.unlink(settingsFile);
}

// 6. loadDotenv: parses KEY=VALUE, comments, export prefix, quotes.
{
  await fs.writeFile(
    envFile,
    [
      '# comment line',
      'OPENAI_API_KEY=sk-real-123',
      'export ANTHROPIC_API_KEY="sk-an-456"',
      'QUOTED=\'single quoted\'',
      'EMPTY=',
    ].join('\n'),
  );
  const e = await loadDotenv(base);
  assert.equal(e.OPENAI_API_KEY, 'sk-real-123');
  assert.equal(e.ANTHROPIC_API_KEY, 'sk-an-456', 'export prefix stripped');
  assert.equal(e.QUOTED, 'single quoted', 'quotes stripped');
  assert.equal(e.EMPTY, '', 'empty value kept');
  ok('loadDotenv: parses comments/export/quotes');
}

// 7. loadDotenv: missing file -> {}.
{
  await fs.unlink(envFile);
  assert.deepEqual(await loadDotenv(base), {});
  ok('loadDotenv: missing file -> {}');
}

// 8. resolveApiKey: lookup-by-name, miss -> use the ref itself.
{
  assert.equal(resolveApiKey('OPENAI_API_KEY', { OPENAI_API_KEY: 'sk-secret' }), 'sk-secret');
  assert.equal(resolveApiKey('sk-direct-789', {}), 'sk-direct-789', 'miss -> ref treated as real key');
  ok('resolveApiKey: hit uses secret, miss uses the ref value');
}

// 9. resolveLlmConfig: placeholder + .env secret -> real key, general.model drives model.
{
  await fs.writeFile(
    settingsFile,
    reg(
      { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      { model: { providerId: 'openai', modelId: 'gpt-4o-mini' } },
    ),
  );
  await fs.writeFile(envFile, 'PROVIDER_OPENAI_API_KEY=sk-from-env');
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.provider, 'OpenAI');
  assert.equal(cfg.protocol, 'openai-completions');
  assert.equal(cfg.model, 'gpt-4o-mini');
  assert.equal(cfg.apiKey, 'sk-from-env');
  ok('resolveLlmConfig: general.model model + placeholder resolves through .env');
}

// 10. resolveLlmConfig: direct real key in settings (no .env hit) -> key itself.
{
  await fs.writeFile(envFile, 'OTHER_VAR=1');
  await fs.writeFile(
    settingsFile,
    reg({ openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'sk-direct-in-settings' } },
      { model: { providerId: 'openai', modelId: 'gpt-4o-mini' } }),
  );
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.apiKey, 'sk-direct-in-settings');
  ok('resolveLlmConfig: .env miss -> apiKeyRef treated as real key');
}

// 11. resolveLlmConfig: apiKeyRef missing from .env -> ref itself returned (SDK
//     will surface auth error); empty apiKeyRef is backfilled to the derived name
//     so it never silently resolves to a usable key. We assert no early throw and
//     that the returned key equals the derived ref.
{
  await fs.writeFile(envFile, 'OTHER_VAR=1');
  await fs.writeFile(
    settingsFile,
    reg({ openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      { model: { providerId: 'openai', modelId: 'gpt-4o-mini' } }),
  );
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.apiKey, 'PROVIDER_OPENAI_API_KEY', 'missing .env key -> ref passed through to SDK');
  ok('resolveLlmConfig: missing .env key -> ref passed through (no silent usable key)');
}

// 12. baseURL: parsed from settings and passed through; absent -> undefined.
{
  await fs.writeFile(envFile, 'PROVIDER_OPENAI_API_KEY=sk-base-url');
  await fs.writeFile(
    settingsFile,
    reg(
      { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY', baseURL: 'https://gateway.example.com/v1' } },
      { model: { providerId: 'openai', modelId: 'gpt-4o-mini' } },
    ),
  );
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.baseURL, 'https://gateway.example.com/v1');
  ok('baseURL: parsed from settings and passed through');
}

// 13. resolveLlmConfig: general.model pointing at missing provider -> falls back to
//     the first *usable* provider (user ∪ builtin; builtin presets win on spread order).
{
  await fs.writeFile(envFile, 'PROVIDER_OPENAI_API_KEY=sk-fb');
  await fs.writeFile(
    settingsFile,
    reg(
      { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      { model: { providerId: 'ghost', modelId: 'nope' } },
    ),
  );
  const cfg = await resolveLlmConfig(base);
  // merged = { ...BUILTIN_PROVIDERS, ...user } -> deepseek is first.
  assert.equal(cfg.provider, 'DeepSeek');
  ok('resolveLlmConfig: dangling general.model -> first usable provider fallback (builtin included)');
}

// 14. loadSettings: parses the general block; invalid model/reasoningLevel/permissionLevel
//     dropped; absent -> undefined. Top-level lastUsedModel/lastUsedLevel are ignored
//     (no compatible read, ADR-0016).
{
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      providers: { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      general: { model: { providerId: 'openai', modelId: 'gpt-4o-mini' }, reasoningLevel: 'high', permissionLevel: 'readonly' },
    }),
  );
  const s = await loadSettings(base);
  assert.deepEqual(s.general.model, { providerId: 'openai', modelId: 'gpt-4o-mini' });
  assert.equal(s.general.reasoningLevel, 'high');
  assert.equal(s.general.permissionLevel, 'readonly');
  // invalid level values dropped -> nothing valid to store -> general absent
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      providers: { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      general: { reasoningLevel: 'extreme', permissionLevel: 'enhanced' },
    }),
  );
  const s2 = await loadSettings(base);
  assert.equal(s2.general, undefined, 'all-invalid general block -> general omitted');
  // legacy top-level lastUsed* ignored (no compat read)
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      providers: { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      lastUsedModel: { providerId: 'openai', modelId: 'gpt-4o' },
      lastUsedLevel: 'high',
    }),
  );
  const s3 = await loadSettings(base);
  assert.equal(s3.general, undefined, 'legacy lastUsed* fields ignored, no general');
  assert.ok(!('lastUsedModel' in s3) && !('lastUsedLevel' in s3), 'lastUsed* not produced');
  ok('loadSettings: parses general (validated), drops invalid, ignores legacy lastUsed*');
}

// 15. resolveLlmConfig: reasoningLevel defaults to medium; general.reasoningLevel honored.
{
  await fs.writeFile(settingsFile, reg({}));
  await fs.writeFile(envFile, 'PROVIDER_DEEPSEEK_API_KEY=sk-fb');
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.reasoningLevel, 'medium');
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      providers: { openai: { displayName: 'OpenAI', protocol: 'openai-completions', apiKeyRef: 'PROVIDER_OPENAI_API_KEY' } },
      general: { reasoningLevel: 'low' },
    }),
  );
  const cfg2 = await resolveLlmConfig(base);
  assert.equal(cfg2.reasoningLevel, 'low');
  ok('resolveLlmConfig: reasoningLevel defaults to medium, honors general.reasoningLevel');
}

// 16. resolveSessionConfig: cascade for reasoning/permission — session override ?? general ?? builtin.
{
  // no override, no general -> builtin defaults
  let r = resolveSessionConfig(undefined, undefined, merged);
  assert.equal(r.reasoningLevel, 'medium');
  assert.equal(r.permissionLevel, 'workspace');
  // general only
  r = resolveSessionConfig(undefined, { reasoningLevel: 'low', permissionLevel: 'readonly' }, merged);
  assert.equal(r.reasoningLevel, 'low');
  assert.equal(r.permissionLevel, 'readonly');
  // session override beats general
  r = resolveSessionConfig(
    { reasoningLevel: 'high', permissionLevel: 'fullaccess' },
    { reasoningLevel: 'low', permissionLevel: 'readonly' },
    merged,
  );
  assert.equal(r.reasoningLevel, 'high');
  assert.equal(r.permissionLevel, 'fullaccess');
  // empty general slot falls through to builtin
  r = resolveSessionConfig(undefined, {}, merged);
  assert.equal(r.reasoningLevel, 'medium');
  ok('resolveSessionConfig: override ?? general ?? builtin cascade for reasoning/permission');
}

// 17. resolveSessionConfig: model — override ?? general ?? dynamic default (first usable provider's first model).
{
  // no override/general -> dynamic default = deepseek's first catalog model
  let r = resolveSessionConfig(undefined, undefined, merged);
  assert.equal(r.model.providerId, 'deepseek');
  assert.equal(r.model.modelId, 'deepseek-chat');
  // general wins over dynamic
  r = resolveSessionConfig(undefined, { model: { providerId: 'openai', modelId: 'gpt-4o-mini' } }, merged);
  assert.equal(r.model.modelId, 'gpt-4o-mini');
  // override wins over general
  r = resolveSessionConfig(
    { model: { providerId: 'anthropic', modelId: 'claude-opus' } },
    { model: { providerId: 'openai', modelId: 'gpt-4o-mini' } },
    merged,
  );
  assert.equal(r.model.providerId, 'anthropic');
  assert.equal(r.model.modelId, 'claude-opus');
  ok('resolveSessionConfig: model override ?? general ?? dynamic default');
}

// 18. resolveSessionConfig: dangling override/general model (provider deleted) -> re-derives
//     to the first usable provider's first model (read-time, no repair path).
{
  const r = resolveSessionConfig(
    { model: { providerId: 'ghost', modelId: 'nope' } },
    { model: { providerId: 'vanished', modelId: 'gone' } },
    merged,
  );
  // neither ghost nor vanished exists -> re-derive to deepseek-chat
  assert.equal(r.model.providerId, 'deepseek');
  assert.equal(r.model.modelId, 'deepseek-chat');
  ok('resolveSessionConfig: dangling model override+general -> dynamic re-derive (no repair write-back)');
}

await fs.rm(base, { recursive: true, force: true });
console.log(`\n${passed} config checks passed.`);
