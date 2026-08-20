// Plain-node unit test for the streaming loop + approval state machine
// (ADR-0011). No API key: drives the loop with a fake streamText result.
// Covers: token-level parts merged to the writer, auto tools executed inline,
// ask tools pausing with a persisted pending event, resume via
// executeApprovedTool (approve runs the tool, deny feeds a refusal back), and
// pendingToolCalls derivation from the message log.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  Harness,
  SessionStore,
  runLoopStreamSegment,
  executeApprovedTool,
  classifyApproval,
  pendingToolCalls,
} from '../dist/index.js';
import { baseExtension } from '../../extensions/dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const ws = 'test-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

// Captured stream lines (formatted protocol lines, e.g. `9:{...}`).
function makeWriter() {
  const lines = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
    writeData(value) {
      lines.push(`2:${JSON.stringify(value)}`);
    },
  };
}

// Fake streamText result: shape of the StreamTextResult parts the loop uses.
function fakeStreamText(turns, opts) {
  let n = 0;
  return function fakeLlm({ messages, tools }) {
    const t = turns[n++];
    if (!t) throw new Error('fake streamText: ran out of scripted turns');
    const toolCalls = (t.toolCalls ?? []).map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
    }));
    // streamText() returns the result synchronously (like the real SDK).
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

// ---- harness + tools -------------------------------------------------------

const store = new SessionStore({ workspace: ws, sessionId: 'sess-stream' });
await store.create();

const harness = new Harness({ workspace: ws });
harness.registerExtension(baseExtension);
harness.registerExtension((api) => {
  api.registerTool({
    name: 'read_thing',
    description: 'read something',
    parameters: z.object({ key: z.string() }),
    approval: 'auto',
    execute: (args) => `read(${args.key})`,
  });
  api.registerTool({
    name: 'write_thing',
    description: 'write something',
    parameters: z.object({ key: z.string() }),
    approval: 'ask',
    execute: (args) => `wrote(${args.key})`,
  });
});
harness.attachSession(store);

// 1. classifyApproval resolves ToolSpec.approval (auto / ask / default ask).
{
  assert.equal(await classifyApproval(harness, 'read_thing', { key: 'a' }), 'auto');
  assert.equal(await classifyApproval(harness, 'write_thing', { key: 'a' }), 'ask');
  // bash: read commands auto, writes ask (function form).
  assert.equal(await classifyApproval(harness, 'bash', { command: 'ls -la' }), 'auto');
  assert.equal(await classifyApproval(harness, 'bash', { command: 'rm x.txt' }), 'ask');
  ok('classifyApproval: auto/ask + bash function form');
}

// 2. Segment with auto tools only: everything streams inline, no pause.
{
  const messages = [{ role: 'user', content: 'do reads' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { text: 'plan: ', toolCalls: [{ toolCallId: 'c1', toolName: 'read_thing', args: { key: 'k' } }] },
    { text: 'done' },
  ]);
  const res = await runLoopStreamSegment(harness, messages, {
    model: {},
    store: null,
    writer,
    messageId: 'm1',
    streamTextCall: llm,
  });
  assert.equal(res.finishReason, 'stop');
  assert.ok(writer.lines.some((l) => l.includes('read(k)')), 'auto tool result streamed');
  assert.equal(writer.lines.filter((l) => l.startsWith('9:')).length, 1, 'tool_call part once');
  assert.equal(messages.length, 4, 'user + assistant + tool + assistant');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.content[0].text, 'done');
  ok('runLoopStreamSegment: auto tools execute inline, one stream, stop');
}

// 3. Ask tool pauses: segment returns tool-calls, pending event persisted.
{
  const messages = [{ role: 'user', content: 'do writes' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'w1', toolName: 'write_thing', args: { key: 'x' } }] },
  ]);
  const res = await runLoopStreamSegment(harness, messages, {
    model: {},
    store,
    writer,
    messageId: 'm2',
    streamTextCall: llm,
  });
  assert.equal(res.finishReason, 'tool-calls');
  assert.ok(
    writer.lines.some((l) => l.includes('approval-pending')),
    'approval-pending data part streamed',
  );
  assert.equal(messages.length, 2, 'assistant persisted, tool NOT executed');
  const ev = await store.lastEvent('tool/approval-pending');
  assert.equal(ev.payload.toolCallId, 'w1');
  assert.equal(ev.payload.toolName, 'write_thing');
  assert.equal(ev.payload.decision, undefined);
  assert.deepEqual(pendingToolCalls(messages), [{ toolCallId: 'w1', toolName: 'write_thing', args: { key: 'x' } }]);
  ok('runLoopStreamSegment: ask tool pauses + persists pending event');
}

// 4. Resume approve: tool runs, result streams, pending cleared.
{
  const messages = [{ role: 'user', content: 'do writes' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'w1', toolName: 'write_thing', args: { key: 'x' } }] },
  ]);
  await runLoopStreamSegment(harness, messages, { model: {}, store, writer, messageId: 'm3', streamTextCall: llm });
  const writer2 = makeWriter();
  await executeApprovedTool(harness, messages, { toolCallId: 'w1', toolName: 'write_thing', args: { key: 'x' } }, 'approve', {
    store,
    writer: writer2,
  });
  assert.ok(writer2.lines.some((l) => l.includes('wrote(x)')), 'tool result streamed on resume');
  assert.deepEqual(pendingToolCalls(messages), [], 'no pending after approve');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'tool');
  assert.equal(last.content[0].result, 'wrote(x)');
  ok('executeApprovedTool: approve runs the tool and streams its result');
}

// 5. Resume deny: refusal fed back to the model, tool NOT executed.
{
  const messages = [{ role: 'user', content: 'do writes' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'w2', toolName: 'write_thing', args: { key: 'y' } }] },
  ]);
  await runLoopStreamSegment(harness, messages, { model: {}, store: null, writer, messageId: 'm4', streamTextCall: llm });
  const writer2 = makeWriter();
  await executeApprovedTool(harness, messages, { toolCallId: 'w2', toolName: 'write_thing', args: { key: 'y' } }, 'deny', {
    store: null,
    writer: writer2,
  });
  assert.match(writer2.lines.join(''), /user denied/i);
  const last = messages[messages.length - 1];
  assert.match(last.content[0].result, /user denied/i);
  ok('executeApprovedTool: deny feeds refusal back, no execution');
}

// 6. Mixed turn: auto tool executes, ask tool pauses at the ask point.
{
  const messages = [{ role: 'user', content: 'read then write' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    {
      text: 'ok ',
      toolCalls: [
        { toolCallId: 'r1', toolName: 'read_thing', args: { key: 'a' } },
        { toolCallId: 'w3', toolName: 'write_thing', args: { key: 'b' } },
      ],
    },
  ]);
  const res = await runLoopStreamSegment(harness, messages, { model: {}, store, writer, messageId: 'm5', streamTextCall: llm });
  assert.equal(res.finishReason, 'tool-calls');
  assert.ok(writer.lines.some((l) => l.includes('read(a)')), 'auto tool ran before pause');
  assert.ok(writer.lines.some((l) => l.includes('w3')), 'ask tool call part present');
  assert.ok(writer.lines.some((l) => l.includes('approval-pending') && l.includes('w3')), 'pause at w3');
  assert.deepEqual(pendingToolCalls(messages), [{ toolCallId: 'w3', toolName: 'write_thing', args: { key: 'b' } }], 'r1 resolved, w3 pending');
  ok('mixed turn: auto before ask, pause at the ask tool');
}

// 7. Persisted assistant/tool message lines replay into a usable history.
{
  const s2 = new SessionStore({ workspace: ws, sessionId: 'sess-stream' });
  const loaded = await s2.load();
  const roles = loaded.messages.map((m) => m.role);
  assert.ok(roles.includes('assistant') && roles.includes('tool'));
  ok('session jsonl: assistant + tool lines persisted for replay');
}

await fs.rm(path.join(os.homedir(), '.applepi', 'sessions', ws), { recursive: true, force: true });
console.log(`stream-loop: ${passed} checks passed`);
