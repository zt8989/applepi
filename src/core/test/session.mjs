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
  slugWorkspace,
} from '../../../dist/core/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-session-test-'));
const ws = 'test-workspace';

// 1. slugWorkspace turns an absolute path into a filesystem-safe token.
{
  assert.equal(slugWorkspace('/Users/x/applepi'), 'Users-x-applepi');
  assert.equal(slugWorkspace('/'), '');
  assert.ok(!slugWorkspace('/a/b').includes('/'));
  ok('slugWorkspace: absolute path -> hyphen slug');
}

// 2. create() generates a session id and creates the file on first append.
{
  const s = new SessionStore({ workspace: ws, sessionId: 'sess-a' });
  const id = await s.create();
  assert.equal(id, 'sess-a');
  await s.appendMessage('user', 'hello');
  const raw = await fs.readFile(s.filePath(), 'utf8');
  assert.match(raw, /"kind":"message"/);
  assert.match(raw, /"session_id":"sess-a"/);
  assert.match(raw, /"workspace":"test-workspace"/);
  ok('create(): fixed id, append writes a valid message line');
}

// 3. Auto session id when none supplied.
{
  const s = new SessionStore({ workspace: ws });
  const id = await s.create();
  assert.match(id, /^[0-9a-f-]{36}$/, 'uuid v4 shape');
  ok('create(): auto uuid session id');
}

// 4. appendEvent writes an event line with type/phase/payload.
{
  const s = new SessionStore({ workspace: ws, sessionId: 'sess-b' });
  await s.create();
  await s.appendEvent('skill', 'start', { name: 'polite', source: 'content' });
  await s.appendEvent('skill', 'end', { ok: true });
  const raw = await fs.readFile(s.filePath(), 'utf8');
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].payload, { name: 'polite', source: 'content' });
  assert.equal(lines[0].kind, 'event');
  assert.equal(lines[0].phase, 'start');
  assert.equal(lines[1].phase, 'end');
  ok('appendEvent: event lines carry type/phase/payload');
}

// 5. load() filters to message lines only.
{
  const s = new SessionStore({ workspace: ws, sessionId: 'sess-c' });
  await s.create();
  await s.appendEvent('system_prompt', 'start', { sections: ['base', 'skills'] });
  await s.appendMessage('system', 'SYS-ORIGINAL');
  await s.appendEvent('system_prompt', 'end', { sections: ['base', 'skills'] });
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
  const s = new SessionStore({ workspace: ws, sessionId: 'sess-d' });
  await s.create();
  await s.appendMessage('system', 'SYS-ORIGINAL');
  await s.appendMessage('user', 'u1');
  await s.appendMessage('assistant', 'a1');
  await s.appendEvent('reload', 'start', { extensionsDiscovered: [], reset: true });
  await s.appendMessage('system', 'SYS-REBUILT-AFTER-RELOAD');
  await s.appendEvent('reload', 'end', { extensionsDiscovered: [], reset: true });
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
  const s = new SessionStore({ workspace: ws });
  const ids = await s.list();
  assert.ok(ids.includes('sess-a'), `has sess-a: ${ids}`);
  assert.ok(ids.includes('sess-d'), `has sess-d: ${ids}`);
  ok('list(): enumerates session ids from the workspace dir');
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} session checks passed.`);
