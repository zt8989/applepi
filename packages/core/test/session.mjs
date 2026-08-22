// Plain-node unit test for the core SessionStore (ADR-0002). No API key.
// Covers: workspace slug, append-only event/message lines, replay transform
// (message lines only), and the reload rule (most-recent system message
// replaces message[0]; original jsonl never mutated).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionStore,
  Harness,
  slugWorkspace,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-session-test-'));
// Unique workspace per run, rooted at tmpRoot (never ~/.applepi) so a fixed
// name would not pollute the real user config and append-only asserts stay clean.
const ws = 'test-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

// 1. slugWorkspace turns an absolute path into a filesystem-safe token.
{
  // Platform-specific exact slugs: POSIX strips the leading slash, Windows
  // keeps the drive (as `C--`, after reserved-char filtering) so different
  // drives never collide on the same session dir.
  if (process.platform === 'win32') {
    assert.equal(slugWorkspace('C:\\Users\\x\\applepi'), 'C--Users-x-applepi');
    assert.equal(slugWorkspace('/'), 'C--');
  } else {
    assert.equal(slugWorkspace('/Users/x/applepi'), 'Users-x-applepi');
    assert.equal(slugWorkspace('/'), '');
  }
  const slug = slugWorkspace('/a/b');
  assert.ok(!slug.includes('/') && !slug.includes('\\'), 'no separators');
  assert.ok(!/[<>:"|?*]/.test(slug), 'no Windows-reserved chars');
  ok('slugWorkspace: absolute path -> safe hyphen slug');
}

// 2. create() generates a session id and creates the file on first append.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-a' });
  const id = await s.create();
  assert.equal(id, 'sess-a');
  await s.appendMessage('user', 'hello');
  const raw = await fs.readFile(s.filePath(), 'utf8');
  assert.match(raw, /"kind":"message"/);
  assert.doesNotMatch(raw, /"session_id"/);
  assert.doesNotMatch(raw, /"workspace"/);
  ok('create(): fixed id, append writes a valid message line');
}

// 3. Auto session id when none supplied.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws });
  const id = await s.create();
  assert.match(id, /^[0-9a-f-]{36}$/, 'uuid v4 shape');
  ok('create(): auto uuid session id');
}

// 4. appendEvent writes an event line with the merged event field (ADR-0006).
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-b' });
  await s.create();
  await s.appendEvent('skill/start', { name: 'polite', source: 'content' });
  await s.appendEvent('skill/end', { ok: true });
  const raw = await fs.readFile(s.filePath(), 'utf8');
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].payload, { name: 'polite', source: 'content' });
  assert.equal(lines[0].kind, 'event');
  assert.equal(lines[0].event, 'skill/start');
  assert.equal(lines[1].event, 'skill/end');
  ok('appendEvent: event lines carry merged event/payload');
}

// 5. load() filters to message lines only.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-c' });
  await s.create();
  await s.appendEvent('system_prompt/start', { sections: ['base', 'skills'] });
  await s.appendMessage('system', 'SYS-ORIGINAL');
  await s.appendEvent('system_prompt/end', { sections: ['base', 'skills'] });
  await s.appendMessage('user', 'hi');
  await s.appendMessage('assistant', 'hello');
  const loaded = await s.load();
  assert.deepEqual(
    loaded.messages.map((m) => m.role),
    ['system', 'user', 'assistant'],
  );
  assert.equal(loaded.messages[0].content, 'SYS-ORIGINAL');
  ok('load(): returns message lines only, in order');
}

// 6. Reload rule: without reload events the original system message stays.
//    With a reload, the most-recent system message replaces message[0] and
//    earlier system messages are dropped. Raw file is untouched.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-d' });
  await s.create();
  await s.appendMessage('system', 'SYS-ORIGINAL');
  await s.appendMessage('user', 'u1');
  await s.appendMessage('assistant', 'a1');
  await s.appendEvent('reload/start', { extensionsDiscovered: [] });
  await s.appendMessage('system', 'SYS-REBUILT-AFTER-RELOAD');
  await s.appendEvent('reload/end', { extensionsDiscovered: [] });
  await s.appendMessage('user', 'u2');

  const loaded = await s.load();
  assert.equal(loaded.messages[0].content, 'SYS-REBUILT-AFTER-RELOAD');
  assert.deepEqual(
    loaded.messages.map((m) => m.content),
    ['SYS-REBUILT-AFTER-RELOAD', 'u1', 'a1', 'u2'],
  );
  // Raw file still contains both system messages (append-only, never mutated).
  const raw = await fs.readFile(s.filePath(), 'utf8');
  assert.ok(raw.includes('SYS-ORIGINAL'));
  assert.ok(raw.includes('SYS-REBUILT-AFTER-RELOAD'));
  ok('reload: most-recent system message replaces message[0], jsonl untouched');
}

// 7. list() enumerates session ids in the workspace.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws });
  const ids = await s.list();
  assert.ok(ids.includes('sess-a'), `has sess-a: ${ids}`);
  assert.ok(ids.includes('sess-d'), `has sess-d: ${ids}`);
  ok('list(): enumerates session ids from the workspace dir');
}

// 8. loadConfig() on a session with no config file returns {} (no fail-fast).
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-empty-cfg' });
  await s.create();
  const cfg = await s.loadConfig();
  assert.deepEqual(cfg, {});
  ok('loadConfig(): missing config file -> {} (no fail-fast)');
}

// 9. saveConfig() writes a sibling <id>.config.json atomically; loadConfig reads it back.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-cfg' });
  await s.create();
  await s.saveConfig({ workspace: '/Users/x/repo', mode: 'base' });
  const file = s.configPath();
  assert.ok(file.endsWith('sess-cfg.config.json'), 'sibling config file path');
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.workspace, '/Users/x/repo');
  assert.equal(onDisk.mode, 'base');
  const cfg = await s.loadConfig();
  assert.deepEqual(cfg, { workspace: '/Users/x/repo', mode: 'base' });
  ok('saveConfig/loadConfig: atomic sibling config file round-trip');
}

// 10. loadConfig() tolerates a corrupt config file -> {}.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-badcfg' });
  await s.create();
  await fs.writeFile(s.configPath(), '{ not valid json', 'utf8');
  const cfg = await s.loadConfig();
  assert.deepEqual(cfg, {});
  ok('loadConfig(): corrupt config file -> {}');
}

// 11. saveConfig overwrites (full rewrite), jsonl untouched.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-cfg2' });
  await s.create();
  await s.appendMessage('user', 'hello');
  await s.saveConfig({ workspace: '/a', mode: 'base' });
  await s.saveConfig({ workspace: '/b', mode: 'standard', reasoningLevel: 'high' });
  const cfg = await s.loadConfig();
  assert.deepEqual(cfg, { workspace: '/b', mode: 'standard', reasoningLevel: 'high' });
  const raw = await fs.readFile(s.filePath(), 'utf8');
  assert.match(raw, /hello/, 'jsonl still holds the message');
  ok('saveConfig: full rewrite overwrites prior config, jsonl untouched');
}

// 12. Harness.resume() restores the persisted identity into session.config.
//    The wiring (config file -> in-memory session.config) is the core of the
//    ticket's resume story: a resumed session picks up workspace/mode from the
//    sibling config file, self-contained (no manifest/event dependency).
{
  const id = 'sess-resume-id';
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: id });
  await s.create();
  await s.appendMessage('user', 'hello');
  await s.saveConfig({ workspace: '/Users/x/repo', mode: 'base' });

  const h = new Harness({ workspace: ws, baseDir: tmpRoot });
  await h.resume(id);
  assert.deepEqual(h.session.config, { workspace: '/Users/x/repo', mode: 'base' });
  assert.equal(h.session.history.length, 1, 'history restored');
  ok('Harness.resume(): restores session.config identity from the config file');
}

// 13. Display metadata primitives (deepen #02 + ADR-0018): title/pinned/notify
//    from the sibling <id>.meta.json (last-wins), defaults when absent; the
//    jsonl itself carries NO UI meta events anymore.
{
  const id = 'sess-meta';
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: id });
  await s.create();
  await s.appendMessage('user', 'fix the login bug');
  await s.updateMeta({ title: 'My explicit title', pinned: true, notify: true });

  assert.equal(await s.title(), 'My explicit title', 'meta title wins over user message');
  assert.equal(await s.pinned(), true, 'meta pinned true');
  assert.equal(await s.notify(), true, 'meta notify true');

  const raw = await fs.readFile(s.filePath(), 'utf8');
  assert.ok(!raw.includes('title/set') && !raw.includes('pin/set') && !raw.includes('notify/set'), 'jsonl free of UI meta events');
  const onDisk = JSON.parse(await fs.readFile(s.metaPath(), 'utf8'));
  assert.deepEqual(onDisk, { title: 'My explicit title', pinned: true, notify: true }, 'meta file holds UI state');

  // updateMeta merges (last-wins per key), other keys untouched.
  const s2 = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-meta-merge' });
  await s2.create();
  await s2.updateMeta({ title: 'T', pinned: true, notify: true });
  await s2.updateMeta({ pinned: false });
  assert.equal(await s2.pinned(), false, 'unpin wins');
  assert.equal(await s2.title(), 'T', 'title preserved across partial update');
  assert.equal(await s2.notify(), true, 'notify preserved across partial update');

  const empty = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-nometa' });
  await empty.create();
  assert.equal(await empty.title(), 'New Chat', 'no meta -> default title');
  assert.equal(await empty.pinned(), false, 'no meta -> false');
  assert.equal(await empty.notify(), false, 'no meta -> false');
  ok('display primitives: title/pinned/notify from meta file, jsonl untouched');
}

// 13b. Legacy sessions (title/set events in an old jsonl, no meta file): the
//      event is ignored — title falls back to the first user message.
{
  const id = 'sess-legacy';
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: id });
  await s.create();
  await s.appendMessage('user', 'legacy session');
  await s.appendEvent('title/set', { title: 'OLD TITLE' });
  await s.appendEvent('pin/set', { pinned: true });
  assert.equal(await s.title(), 'legacy session', 'legacy title/set ignored, first-user fallback');
  assert.equal(await s.pinned(), false, 'legacy pin/set ignored, default false');
  ok('legacy jsonl: UI meta events ignored without a meta file');
}

// 14. title() falls back to the first user message (truncated at 40 chars)
//    with a parts-array content shape.
{
  const id = 'sess-title-fallback';
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: id });
  await s.create();
  const long = 'x'.repeat(60);
  await s.appendMessage('user', [{ type: 'text', text: long }]);
  assert.equal(s.title ? await s.title() : '', 'x'.repeat(40) + '…', 'truncated first-user fallback');
  const s2 = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-title-fallback2' });
  await s2.create();
  await s2.appendMessage('user', [{ type: 'text', text: 'short msg' }]);
  assert.equal(await s2.title(), 'short msg', 'short first-user fallback');
  ok('title(): first user message fallback + 40-char truncation');
}

// 15. listSessions() returns display metadata rows sorted newest-mtime-first.
{
  const s = new SessionStore({ baseDir: tmpRoot, workspace: ws });
  const rows = await s.listSessions();
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('sess-meta'), 'listSessions includes sess-meta');
  assert.ok(ids.includes('sess-title-fallback'), 'listSessions includes new sessions');
  const mtime = rows.map((r) => Date.parse(r.ts));
  for (let i = 1; i < mtime.length; i++) {
    assert.ok(mtime[i - 1] >= mtime[i], `rows sorted by mtime desc: ${ids}`);
  }
  const meta = rows.find((r) => r.id === 'sess-meta');
  assert.equal(meta.title, 'My explicit title');
  assert.equal(meta.pinned, true);
  assert.equal(meta.notify, true);
  ok(`listSessions(): ${rows.length} rows, mtime-desc, metadata resolved`);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} session checks passed.`);
