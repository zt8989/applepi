// Plain-node unit test for the core LLM config primitives (ADR-0004). No API key.
// Covers: loadSettings (missing → throw / parse / invalid JSON), loadDotenv (parse
// rules), resolveApiKey (lookup-by-name), resolveLlmConfig (placeholder+secret,
// direct key, fail-fast). All runs use an injected temp baseDir, self-cleaned.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSettings,
  loadDotenv,
  resolveApiKey,
  resolveLlmConfig,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-config-test-'));
const settingsFile = path.join(base, 'settings.json');
const envFile = path.join(base, '.env');

// 1. loadSettings: missing file -> throws (fail fast, ADR-0004 amendment).
{
  await assert.rejects(() => loadSettings(base), /settings\.json not found/);
  ok('loadSettings: missing file -> throws (fail fast)');
}

// 2. loadSettings: valid JSON parsed (partial fields fall back).
{
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }));
  const s = await loadSettings(base);
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.model, 'claude-3-5-sonnet-latest');
  assert.equal(s.apiKey, 'ANTHROPIC_API_KEY', 'default apiKey follows provider');
  ok('loadSettings: parses JSON, apiKey default follows provider');
}

// 3. loadSettings: malformed JSON -> throws.
{
  await fs.writeFile(settingsFile, '{ not json');
  await assert.rejects(() => loadSettings(base), /not valid JSON/);
  ok('loadSettings: malformed JSON -> throw');
  await fs.unlink(settingsFile);
}

// 4. loadDotenv: parses KEY=VALUE, comments, export prefix, quotes.
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

// 5. loadDotenv: missing file -> {}.
{
  await fs.unlink(envFile);
  assert.deepEqual(await loadDotenv(base), {});
  ok('loadDotenv: missing file -> {}');
}

// 6. resolveApiKey: lookup-by-name, miss -> use the ref itself.
{
  assert.equal(resolveApiKey('OPENAI_API_KEY', { OPENAI_API_KEY: 'sk-secret' }), 'sk-secret');
  assert.equal(resolveApiKey('sk-direct-789', {}), 'sk-direct-789', 'miss -> ref treated as real key');
  ok('resolveApiKey: hit uses secret, miss uses the ref value');
}

// 7. resolveLlmConfig: placeholder + .env secret -> real key.
{
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'OPENAI_API_KEY' }));
  await fs.writeFile(envFile, 'OPENAI_API_KEY=sk-from-env');
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-from-env');
  ok('resolveLlmConfig: placeholder resolves through .env');
}

// 8. resolveLlmConfig: direct real key in settings (no .env hit) -> key itself.
{
  await fs.writeFile(envFile, 'OTHER_VAR=1');
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-direct-in-settings' }));
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.apiKey, 'sk-direct-in-settings');
  ok('resolveLlmConfig: .env miss -> settings value treated as real key');
}

// 9. resolveLlmConfig: unusable key -> fail fast with guidance.
{
  await fs.writeFile(envFile, 'OTHER_VAR=1');
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKey: '' }));
  await assert.rejects(() => resolveLlmConfig(base), /no usable apiKey/);
  ok('resolveLlmConfig: empty/unusable key -> throws with guidance');
}

// 10. resolveLlmConfig: unsupported provider -> throws.
{
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'groq', model: 'x', apiKey: 'k' }));
  await assert.rejects(() => resolveLlmConfig(base), /unsupported LLM provider/);
  ok('resolveLlmConfig: unsupported provider -> throws');
}

// 11. baseURL: parsed from settings and passed through; absent -> undefined.
{
  await fs.writeFile(envFile, 'OPENAI_API_KEY=sk-base-url');
  await fs.writeFile(
    settingsFile,
    JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'OPENAI_API_KEY', baseURL: 'https://gateway.example.com/v1' }),
  );
  const s = await loadSettings(base);
  assert.equal(s.baseURL, 'https://gateway.example.com/v1');
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.baseURL, 'https://gateway.example.com/v1');
  ok('baseURL: parsed from settings and passed through');
}

// 12. baseURL: absent from settings -> undefined (SDK default used).
{
  await fs.writeFile(settingsFile, JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'OPENAI_API_KEY' }));
  const cfg = await resolveLlmConfig(base);
  assert.equal(cfg.baseURL, undefined);
  ok('baseURL: absent -> undefined');
}

await fs.rm(base, { recursive: true, force: true });
console.log(`\n${passed} config checks passed.`);
