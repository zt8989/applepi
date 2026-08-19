// End-to-end check for session persistence (ADR-0002), driven without a real
// LLM/API key. Exercises: system-prompt emission, per-turn message persistence,
// skill_load start/end events, resume (history restore), listSessions, and the
// reload rule (rebuilt system prompt replaces message[0], scratch preserved).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Harness,
  SessionStore,
} from '@applepi/core';
import { baseExtension, createSkillsExtension } from '@applepi/extensions';

const WS = 'check-session-tmp';
const DIR = path.join(os.homedir(), '.applepi', 'sessions', WS);

function boot(store: SessionStore): Harness {
  const harness = new Harness();
  harness.registerExtension(baseExtension);
  harness.registerExtension(createSkillsExtension());
  harness.registerExtension((api) =>
    api.addSystemPromptContributor(() => 'BASE-INSTRUCTIONS', 'base'),
  );
  harness.attachSession(store);
  return harness;
}

// --- fresh session ---------------------------------------------------------
const store = new SessionStore({ workspace: WS });
await store.create();
const sid = store.sessionId!;
let harness = boot(store);
await harness.emitSystemPrompt();

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

await harness.run('be nice', {}, { llmCall: fakeLlm, maxTurns: 6 });

// 1. jsonl has system message + user + assistant + tool lines, plus skill events.
const raw = await fs.readFile(store.filePath(), 'utf8');
const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const roles = lines.filter((l) => l.kind === 'message').map((l) => l.role);
console.log('--- message roles:', roles.join(','));
console.log('--- event types:', lines.filter((l) => l.kind === 'event').map((l) => l.event).join(','));

if (!roles.includes('system') || !roles.includes('user') || !roles.includes('assistant') || !roles.includes('tool')) {
  console.error('check-session: FAIL (missing message roles)');
  process.exit(1);
}
const skillEvents = lines.filter((l) => l.kind === 'event' && (l.event === 'skill/start' || l.event === 'skill/end'));
if (skillEvents.length !== 2 || skillEvents[0].event !== 'skill/start' || skillEvents[1].event !== 'skill/end') {
  console.error('check-session: FAIL (skill start/end events)');
  process.exit(1);
}

// 2. Replay: first message is the emitted system prompt.
const loaded = await store.load();
if (loaded.messages[0].role !== 'system' || !loaded.messages[0].content.includes('BASE-INSTRUCTIONS')) {
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

// 3. listSessions includes the session.
const ids = await h2.listSessions();
console.log('--- sessions:', ids.join(','));
if (!ids.includes(sid)) {
  console.error('check-session: FAIL (listSessions missing sid)');
  process.exit(1);
}

// --- reload: preserved scratch + history, rebuilt system prompt replaces msg[0] --
const storeR = new SessionStore({ workspace: WS });
await storeR.create();
let hR = boot(storeR);
await hR.emitSystemPrompt(); // original: BASE only
hR.session.scratch = harness.session.scratch; // skill "polite" carried over
hR.session.history = harness.session.history;
await storeR.appendEvent('reload/start', { extensionsDiscovered: [] });
await hR.emitSystemPrompt(); // rebuilt: BASE + [Skill: polite]
await storeR.appendEvent('reload/end', { extensionsDiscovered: [] });
const lr = await storeR.load();
const rebuilt = lr.messages[0].content;
console.log('--- rebuilt system prompt head:', rebuilt.slice(0, 120));
if (!rebuilt.includes('BASE-INSTRUCTIONS') || !rebuilt.includes('[Skill: polite]')) {
  console.error('check-session: FAIL (reload rebuild did not include skill)');
  process.exit(1);
}

await fs.rm(DIR, { recursive: true, force: true });
console.log('check-session: OK');
