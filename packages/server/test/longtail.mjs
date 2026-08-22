// Request-level smoke tests for the longtail routes (ADR-0017 ticket 04):
// /api/files, /api/config* and /api/pick-folder on the shared server.
// Only SAFE paths are exercised — nothing here writes the real
// ~/.applepi/settings.json (validation/error paths reject before any write;
// read paths are catch-tolerant).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../dist/index.js';

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}`);
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-longtail-'));
const wsDir = path.join(tmpRoot, 'proj');
await fs.mkdir(wsDir);
await fs.mkdir(path.join(wsDir, 'src'));
await fs.writeFile(path.join(wsDir, 'src', 'main.ts'), 'export const x = 1;\n');
await fs.writeFile(path.join(wsDir, 'README.md'), '# proj\n');
await fs.mkdir(path.join(wsDir, 'node_modules'));
await fs.writeFile(path.join(wsDir, 'node_modules', 'big.js'), 'x');
process.env.APPLEPI_SESSIONS_DIR = path.join(tmpRoot, 'sessions');

const app = createApp();
const json = (body, method = 'POST') => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

// 1. /api/files: bounded walk, skips node_modules, honors q filter.
{
  let res = await app.request('/api/files?workspace=' + encodeURIComponent(wsDir));
  assert.equal(res.status, 200);
  let { files } = await res.json();
  ok('files: lists project files', files.includes('README.md') && files.includes('src/main.ts'));
  ok('files: never descends into node_modules', !files.some((f) => f.includes('node_modules')));

  res = await app.request('/api/files?workspace=' + encodeURIComponent(wsDir) + '&q=readme');
  ({ files } = await res.json());
  assert.deepEqual(files, ['README.md'], 'q filter narrows to matches');

  res = await app.request('/api/files?workspace=relative/path');
  assert.equal(res.status, 400, 'non-absolute workspace rejected');
  res = await app.request('/api/files?workspace=' + encodeURIComponent(path.join(tmpRoot, 'missing')));
  assert.equal(res.status, 400, 'inaccessible workspace rejected');
}

// 2. /api/config: safe GET tolerates the (possibly empty) registry.
{
  const res = await app.request('/api/config');
  assert.equal(res.status, 200);
  const body = await res.json();
  ok('config: GET returns provider/model fields (empty-tolerant)', typeof body.provider === 'string' && typeof body.model === 'string');
}

// 3. /api/config/general: GET tolerant; PUT rejects invalid level before write.
{
  let res = await app.request('/api/config/general');
  assert.equal(res.status, 200);
  res = await app.request('/api/config/general', json({ reasoningLevel: 'bogus' }, 'PUT'));
  assert.equal(res.status, 500, 'invalid reasoningLevel rejected (route-level catch)');
  res = await app.request('/api/config/general', json({ model: { providerId: 'x' } }, 'PUT'));
  assert.equal(res.status, 500, 'incomplete model rejected');
}

// 4. /api/config/providers: PUT validates ids/protocols before any write.
{
  let res = await app.request('/api/config/providers', json({ providers: { 'Bad-ID': {} } }, 'PUT'));
  assert.equal(res.status, 400, 'illegal provider id rejected');
  res = await app.request('/api/config/providers', json({ providers: { custom1: { protocol: 'weird', apiKeyRef: 'x' } } }, 'PUT'));
  assert.equal(res.status, 400, 'illegal protocol rejected');
  // `providers: {}` is a legal "remove all" payload — the 400 is a MISSING key.
  res = await app.request('/api/config/providers', json({}, 'PUT'));
  assert.equal(res.status, 400, 'missing providers map rejected');
}

// 5. /api/config/models: anthropic protocol → 405; missing providerId → 400.
{
  let res = await app.request('/api/config/models');
  assert.equal(res.status, 400, 'missing providerId rejected');
  res = await app.request('/api/config/models?providerId=anthropic');
  assert.equal(res.status, 405, 'anthropic protocol reports 405');
}

// 6. /api/config/last-used + last-used-level: validation rejects before write.
{
  let res = await app.request('/api/config/last-used', json({ providerId: 'x' }));
  assert.equal(res.status, 400, 'missing modelId rejected');
  res = await app.request('/api/config/last-used-level', json({ level: 'bogus' }));
  assert.equal(res.status, 400, 'invalid level rejected');
}

// 7. /api/config/open-file + /api/pick-folder: platform-gated, no side effects.
{
  let res = await app.request('/api/config/open-file');
  assert.equal(res.status, 200);
  const { hidden } = await res.json();
  ok('open-file: exposes hidden flag without opening', typeof hidden === 'boolean');
  res = await app.request('/api/config/open-file', json({}));
  assert.equal(res.status, 200);
  const postBody = await res.json();
  ok('open-file: POST answers without crashing', typeof postBody.hidden === 'boolean');
  res = await app.request('/api/pick-folder', json({}));
  assert.equal(res.status, 400, 'pick-folder unavailable off macOS');
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} longtail checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);