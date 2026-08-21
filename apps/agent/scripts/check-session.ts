// End-to-end check for session persistence (ADR-0002) under the ADR-0015 flat
// model, driven without a real LLM/API key. Exercises: app-layer system-prompt
// persistence at session start, per-turn message persistence, skill_load into
// session scratch, resume (history restore), listSessions, and the reload rule
// (a rebuilt system message between reload events replaces message[0]).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness, SessionStore } from '@applepi/core';
import {
  makeBundleSpec,
  bundleEnv,
  enableBundleSpec,
  assembleFlatPrompt,
} from '@applepi/bundle';

const WS = 'check-session-tmp';
const DIR = path.join(os.homedir(), '.applepi', 'sessions', WS);

function boot(store: SessionStore): Harness {
  const harness = new Harness();
  // Standard bundle: bash + sre + memory + skills (same as main.ts, ADR-0015).
  const spec = makeBundleSpec('standard', { cwd: process.cwd() })!;
  enableBundleSpec(harness, spec);
  harness.attachSession(store);
  return harness;
}

/** The flat system prompt assembled for the standard bundle at the current level. */
function systemPromptOf(harness: Harness): string {
  return assembleFlatPrompt(
    harness,
    makeBundleSpec('standard', bundleEnv(harness))!,
    { app: [] },
  );
}

// --- fresh session ---------------------------------------------------------
const store = new SessionStore({ workspace: WS });
await store.create();
const sid = store.sessionId!;
let harness = boot(store);
const sysMsg = systemPromptOf(harness);
// The app persists the initial system message once at session start (ADR-0015).
await store.appendMessage('system', sysMsg);

let turn = 0;
const fakeLlm: any = async () => {
  turn++;
  if (turn === 1) {
    return {
      text: 'loading skill',
      toolCalls: [
        { toolCallId: 't1', toolName: 'skill_load', args: { name: 'polite', content: 'Be nice.' } },
      ],
    };
  }
  return { text: 'done' };
};

await harness.run('be nice', sysMsg, {}, { llmCall: fakeLlm, maxTurns: 6 });

// 1. jsonl has system + user + assistant + tool message lines.
const raw = await fs.readFile(store.filePath(), 'utf8');
const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const roles = lines.filter((l) => l.kind === 'message').map((l) => l.role);
console.log('--- message roles:', roles.join(','));
console.log('--- event types:', lines.filter((l) => l.kind === 'event').map((l) => l.event).join(','));

if (!roles.includes('system') || !roles.includes('user') || !roles.includes('assistant') || !roles.includes('tool')) {
  console.error('check-session: FAIL (missing message roles)');
  process.exit(1);
}

// 2. skill_load went into session scratch (no skill/start|end span events —
//    observability moved to trace, ADR-0015).
if (harness.session.scratch['__skills']?.polite !== 'Be nice.') {
  console.error('check-session: FAIL (skill_load did not reach session scratch)');
  process.exit(1);
}

// 3. Replay: first message is the persisted system prompt.
const loaded = await store.load();
if (loaded.messages[0].role !== 'system' || !loaded.messages[0].content.includes('You are a coding agent')) {
  console.error('check-session: FAIL (replay first message is system prompt)');
  process.exit(1);
}

// --- resume ----------------------------------------------------------------
let h2 = boot(store);
const s2 = await h2.resume(sid);
if (s2.sessionId !== sid) {
  console.error('check-session: FAIL (resume kept session id)');
  process.exit(1);
}
const histRoles = h2.session.history.map((m: any) => m.role);
console.log('--- resumed history roles:', histRoles.join(','));
if (!histRoles.includes('user') || histRoles.includes('system')) {
  console.error('check-session: FAIL (resume restores turns, drops system)');
  process.exit(1);
}

// 4. listSessions includes the session.
const ids = await h2.listSessions();
console.log('--- sessions:', ids.join(','));
if (!ids.includes(sid)) {
  console.error('check-session: FAIL (listSessions missing sid)');
  process.exit(1);
}

// --- reload: rebuilt system message between reload events replaces msg[0] ---
const storeR = new SessionStore({ workspace: WS });
await storeR.create();
let hR = boot(storeR);
const original = systemPromptOf(hR);
await storeR.appendMessage('system', original); // original: standard declaration only

// Simulate the app-layer /reload: skill already loaded, rebuild + persist.
hR.session.scratch['__skills'] = { polite: 'Be nice.' };
const rebuilt = systemPromptOf(hR);
await storeR.appendEvent('reload/start', { pluginsDiscovered: [] });
await storeR.appendMessage('system', rebuilt);
await storeR.appendEvent('reload/end', { pluginsDiscovered: [] });

const lr = await storeR.load();
const head = lr.messages[0].content;
console.log('--- rebuilt system prompt contains skill:', head.includes('[Skill: polite]'));
if (!head.includes('[Skill: polite]')) {
  console.error('check-session: FAIL (reload rebuild did not include skill)');
  process.exit(1);
}

await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
console.log('check-session: OK');
