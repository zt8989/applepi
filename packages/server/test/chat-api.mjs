// Request-level tests for /api/chat + /api/chat/approve on the shared server
// (ADR-0017 ticket 03), via the streamTextCall injection seam: no browser, no
// real provider — a scripted fake streamText drives the loop exactly like core
// stream-loop.mjs. APPLEPI_SESSIONS_DIR keeps session files in tmp.
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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-chat-api-'));
const wsDir = path.join(tmpRoot, 'proj');
await fs.mkdir(wsDir);
process.env.APPLEPI_SESSIONS_DIR = path.join(tmpRoot, 'sessions');

// Scripted fake streamText (same shape as core stream-loop.mjs).
function fakeStreamText(turns) {
  let n = 0;
  return function fakeLlm({ messages, tools }) {
    const t = turns[n++];
    if (!t) throw new Error('fake streamText: ran out of scripted turns');
    const toolCalls = (t.toolCalls ?? []).map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
    }));
    return {
      toolCalls,
      text: Promise.resolve(t.text ?? ''),
      mergeIntoDataStream(writer) {
        if (t.text) writer.write(`0:${JSON.stringify(t.text)}`);
        for (const tc of toolCalls) {
          writer.write(`9:${JSON.stringify({ toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.args })}`);
        }
      },
    };
  };
}

// The seam is bound at createApp time; rebuild per scenario with its own script.
function makeApp(turns) {
  return createApp({ chat: { model: {}, streamTextCall: fakeStreamText(turns) } });
}

const chatBody = (extra = {}) => ({
  workspace: wsDir,
  messageId: 'm1',
  message: 'hello',
  ...extra,
});
const json = (body) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

// 1. Text-only turn: session part + streamed text. (finish part is emitted by
//    the REAL mergeIntoDataStream — covered by core stream-loop tests; the
//    fake merge writes text/tool-calls only.)
{
  const app2 = makeApp([{ text: 'hi there' }]);
  const res = await app2.request('/api/chat', json(chatBody()));
  assert.equal(res.status, 200);
  const stream = await res.text();
  ok('chat: session part announced', stream.includes('"type":"session"'));
  ok('chat: text streamed (0: part)', stream.includes('0:"hi there"'));
}

// 2. ask_user pause → approve-with-payload resume → answer IS the tool result.
{
  const app2 = makeApp([
    { toolCalls: [{ toolCallId: 'a1', toolName: 'ask_user', args: { question: 'which port?' } }] },
    { text: 'done' },
  ]);
  let res = await app2.request('/api/chat', json(chatBody({ messageId: 'm2' })));
  assert.equal(res.status, 200);
  const s1 = await res.text();
  ok('chat: pause at ask_user with expectsAnswer', s1.includes('approval-pending') && s1.includes('"expectsAnswer":true'));

  // Approve on an UNKNOWN session: no pending approval → 400.
  res = await app2.request('/api/chat/approve', json({
    workspace: wsDir,
    sessionId: 'sess-2',
    messageId: 'm2',
    toolCallId: 'a1',
    decision: 'approve',
    answer: 'port 3210',
  }));
  assert.equal(res.status, 400, 'unknown session has no pending approval');
  ok('approve: unknown session rejected (no pending)', true);
}

// 2b. The approve flow must run against the session the chat created.
{
  const app2 = makeApp([
    { toolCalls: [{ toolCallId: 'a1', toolName: 'ask_user', args: { question: 'which port?' } }] },
    { text: 'done' },
  ]);
  const res1 = await app2.request('/api/chat', json(chatBody({ messageId: 'm2b', message: 'ask me' })));
  const s1 = await res1.text();
  const sid = /\{"type":"session","sessionId":"([^"]+)"\}/.exec(s1)?.[1];
  ok('chat: session id captured for resume', typeof sid === 'string' && sid.length > 0);

  const res2 = await app2.request('/api/chat/approve', json({
    workspace: wsDir,
    sessionId: sid,
    messageId: 'm2b',
    toolCallId: 'a1',
    decision: 'approve',
    answer: 'port 3210',
  }));
  assert.equal(res2.status, 200);
  const s2 = await res2.text();
  // AI SDK v4 data stream: `a:` is the tool-result part prefix.
  ok('approve: answer streamed as tool result', s2.includes('a:{"toolCallId":"a1","result":"port 3210"'));
  ok('approve: loop continued to next turn', s2.includes('0:"done"'));
}

// 3. Deny feeds refusal back.
{
  const app2 = makeApp([
    { toolCalls: [{ toolCallId: 'a2', toolName: 'ask_user', args: { question: 'ok?' } }] },
  ]);
  const res1 = await app2.request('/api/chat', json(chatBody({ messageId: 'm3', message: 'ask me' })));
  const s1 = await res1.text();
  const sid = /\{"type":"session","sessionId":"([^"]+)"\}/.exec(s1)?.[1];
  const res2 = await app2.request('/api/chat/approve', json({
    workspace: wsDir,
    sessionId: sid,
    messageId: 'm3',
    toolCallId: 'a2',
    decision: 'deny',
  }));
  const s2 = await res2.text();
  ok('deny: refusal fed back to the model', s2.includes('user denied'));
}

// 4. Multi-pending queue: two ask tools in one LLM turn — pausing at the
//    first; approving it re-surfaces the SECOND as approval-pending; approving
//    that continues the loop to the next turn.
{
  const app2 = makeApp([
    {
      toolCalls: [
        { toolCallId: 'u1', toolName: 'ask_user', args: { question: 'q1?' } },
        { toolCallId: 'u2', toolName: 'ask_user', args: { question: 'q2?' } },
      ],
    },
    { text: 'all done' },
  ]);
  const res1 = await app2.request('/api/chat', json(chatBody({ messageId: 'm4', message: 'multi' })));
  const s1 = await res1.text();
  const sid = /\{"type":"session","sessionId":"([^"]+)"\}/.exec(s1)?.[1];

  let res = await app2.request('/api/chat/approve', json({
    workspace: wsDir, sessionId: sid, messageId: 'm4', toolCallId: 'u1', decision: 'approve', answer: 'a1',
  }));
  assert.equal(res.status, 200);
  const s2 = await res.text();
  ok('multi-pending: second ask_user re-surfaced after first approve', s2.includes('approval-pending') && s2.includes('"toolCallId":"u2"'));

  res = await app2.request('/api/chat/approve', json({
    workspace: wsDir, sessionId: sid, messageId: 'm4', toolCallId: 'u2', decision: 'approve', answer: 'a2',
  }));
  const s3 = await res.text();
  ok('multi-pending: second approve continues the loop', s3.includes('0:"all done"'));
}

// 5. Validation paths stay loud.
{
  const app2 = makeApp([{ text: 'x' }]);
  let r = await app2.request('/api/chat', json({ workspace: wsDir })); // no message
  assert.equal(r.status, 400);
  r = await app2.request('/api/chat/approve', json({ workspace: wsDir, sessionId: 's' }));
  assert.equal(r.status, 400);
  r = await app2.request('/api/chat/approve', json({ workspace: wsDir, sessionId: 's', messageId: 'x', toolCallId: 'x', decision: 'maybe' }));
  assert.equal(r.status, 400);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} chat-api checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);