// Request-level tests for /api/session + /api/workspaces on the shared server
// (ADR-0017 ticket 02), with APPLEPI_SESSIONS_DIR pointing at a temp root so
// nothing touches the real ~/.applepi/sessions.
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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-sess-api-'));
const wsDir = path.join(tmpRoot, 'proj');
await fs.mkdir(wsDir);
process.env.APPLEPI_SESSIONS_DIR = path.join(tmpRoot, 'sessions');

const app = createApp();
const get = (p) => app.request(p);

// 1. Workspace add → appears in list with basename display name.
{
  let res = await app.request('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ path: wsDir }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const added = await res.json();
  ok('POST /api/workspaces registers the workspace', added.slug && added.path === wsDir);

  res = await get('/api/workspaces');
  assert.equal(res.status, 200);
  const { workspaces } = await res.json();
  ok('GET /api/workspaces lists it with basename name', workspaces.length === 1 && workspaces[0].name === 'proj' && workspaces[0].sessions.length === 0);
}

// 2. Session create via PATCH 'rename' (creates the jsonl) → hydrate round-trip.
{
  const sid = 'sess-abc';
  let res = await app.request('/api/session', {
    method: 'PATCH',
    body: JSON.stringify({ workspace: wsDir, sessionId: sid, action: 'rename', title: 'my session' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  res = await get(`/api/session?workspace=${encodeURIComponent(wsDir)}&session=${sid}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  ok('hydrate returns messages + level + mode + title', Array.isArray(body.messages) && body.level === 'workspace' && body.mode === 'standard' && body.title === 'my session');
  ok('hydrate has no outstanding pending', body.pending === null);
  ok('reasoning default present (medium)', body.reasoning === 'medium' || body.reasoning === undefined);
}

// 3. Session actions: pin → notify→ level → reasoning → model → archive/unarchive.
{
  const sid = 'sess-abc';
  const patch = async (payload, expect = 200) => {
    const r = await app.request('/api/session', {
      method: 'PATCH',
      body: JSON.stringify({ workspace: wsDir, sessionId: sid, ...payload }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.status, expect, `PATCH ${payload.action} -> ${expect}`);
    return r;
  };
  await patch({ action: 'pin' });
  await patch({ action: 'notify', enabled: true });
  await patch({ action: 'level', level: 'readonly' });
  await patch({ action: 'reasoning', reasoning: 'high' });
  await patch({ action: 'model', model: { providerId: 'deepseek', modelId: 'deepseek-chat' } });

  // Level persisted into session.config override + restored by bindSession.
  const res = await get(`/api/session?workspace=${encodeURIComponent(wsDir)}&session=${sid}`);
  const body = await res.json();
  ok('level action reflected in hydrate', body.level === 'readonly');
  ok('reasoning override reflected in hydrate', body.reasoning === 'high');
  const config = JSON.parse(await fs.readFile(path.join(process.env.APPLEPI_SESSIONS_DIR, (await (await get('/api/workspaces')).json()).workspaces[0].slug, `${sid}.config.json`), 'utf8'));
  ok('model override persisted to <id>.config.json', config.model?.modelId === 'deepseek-chat');

  // Archive moves the jsonl; unarchive restores it.
  const slug = (await (await get('/api/workspaces')).json()).workspaces[0].slug;
  const sessDir = path.join(process.env.APPLEPI_SESSIONS_DIR, slug);
  await patch({ action: 'archive' });
  ok('archive moved the jsonl', !(await fs.stat(path.join(sessDir, `${sid}.jsonl`)).catch(() => null)) && (await fs.stat(path.join(sessDir, '.archive', `${sid}.jsonl`)).then(() => true)));
  await patch({ action: 'unarchive' });
  ok('unarchive restored the jsonl', !!(await fs.stat(path.join(sessDir, `${sid}.jsonl`)).catch(() => null)));
}

// 4. Validation paths stay loud and typed.
{
  let r = await get('/api/session');
  assert.equal(r.status, 400);
  r = await app.request('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: path.join(tmpRoot, 'nope') }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400, 'non-directory workspace rejected');
  r = await app.request('/api/session', { method: 'PATCH', body: JSON.stringify({ workspace: wsDir, sessionId: 's', action: 'level', level: 'bogus' }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400, 'invalid level rejected');
}

// 5. jsonl export: contents + the meta file holding UI state (ADR-0018).
{
  const r = await get(`/api/session?workspace=${encodeURIComponent(wsDir)}&session=sess-abc&format=jsonl`);
  assert.equal(r.status, 200);
  const raw = await r.text();
  const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('jsonl export returns parseable ndjson', rows.every((l) => l && typeof l === 'object'));
  ok('jsonl free of UI meta events', !raw.includes('title/set') && !raw.includes('pin/set') && !raw.includes('notify/set'));
  const slug = (await (await get('/api/workspaces')).json()).workspaces[0].slug;
  const meta = JSON.parse(await fs.readFile(path.join(process.env.APPLEPI_SESSIONS_DIR, slug, 'sess-abc.meta.json'), 'utf8'));
  ok('meta file holds rename/pin/notify state', meta.title === 'my session' && meta.pinned === true && meta.notify === true);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} session/workspaces checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);