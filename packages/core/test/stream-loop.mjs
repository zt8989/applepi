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
  reasoningProviderOptions,
} from '../dist/index.js';
import { bashTool } from '../../extension/dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const ws = 'test-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
// Inject a temp root so the store never touches ~/.applepi (sandbox-safe).
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-stream-test-'));

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

// Event lines of a session, in write order (ADR-0018 lifecycle assertions).
async function eventsOf(store) {
  const raw = await fs.readFile(store.filePath(), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.kind === 'event');
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

const store = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-stream' });
await store.create();

const harness = new Harness({ workspace: ws });
// Tools are registered directly on the harness shell (ADR-0015: no extension
// bus; the app assembles the tool set from bundles/capabilities/plugins).
harness.registerTool(bashTool);
harness.registerTool({
  name: 'read_thing',
  description: 'read something',
  parameters: z.object({ key: z.string() }),
  approval: 'auto',
  execute: (args) => `read(${args.key})`,
});
harness.registerTool({
  name: 'write_thing',
  description: 'write something',
  parameters: z.object({ key: z.string() }),
  approval: 'ask',
  execute: (args) => `wrote(${args.key})`,
});
// Probe for #02 approve-with-payload (ask_user shape): asks the user for a
// free-text reply; its execute must NEVER run (the answer IS the result).
let userInputExecuted = false;
harness.registerTool({
  name: 'user_input',
  description: 'ask the user a question',
  parameters: z.object({ question: z.string() }),
  approval: 'ask',
  expectsAnswer: true,
  execute: async () => {
    userInputExecuted = true;
    return 'SHOULD NOT RUN';
  },
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

// 3. Ask tool pauses: segment returns tool-calls, pending event persisted,
//    tool_call interval stays OPEN (no end until the decision).
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
  const pend = await store.pendingToolCall();
  assert.equal(pend.toolCallId, 'w1');
  assert.equal(pend.toolName, 'write_thing');
  assert.deepEqual(pend.args, { key: 'x' });
  assert.equal(pend.expectsAnswer, false);
  assert.deepEqual(pendingToolCalls(messages), [{ toolCallId: 'w1', toolName: 'write_thing', args: { key: 'x' } }]);
  const evs = await eventsOf(store);
  assert.equal(evs.find((e) => e.event === 'tool/approval-pending'), undefined, 'no tool/approval-pending event persists');
  const start = evs.filter((e) => e.event === 'tool_call/start' && e.payload.toolCallId === 'w1');
  const end = evs.filter((e) => e.event === 'tool_call/end' && e.payload.toolCallId === 'w1');
  assert.equal(start.length, 1, 'tool_call/start written at generation');
  assert.deepEqual(start[0].payload, { toolCallId: 'w1', toolName: 'write_thing', args: { key: 'x' }, expectsAnswer: false });
  assert.equal(end.length, 0, 'ask tool_call interval stays open');
  const turnEnd = evs.find((e) => e.event === 'turn/end');
  assert.deepEqual(turnEnd.payload, { finishReason: 'tool-calls' }, 'turn closes at the ask pause');
  ok('runLoopStreamSegment: ask tool pauses + persists pending event');
}

// 3c. (lifecycle) turn interval for a text-only segment: turn/start at the
//     head, turn/end{stop} at the tail, nothing else.
{
  const s3 = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-turn' });
  await s3.create();
  const h2 = new Harness({ workspace: ws });
  h2.registerTool({
    name: 'read_thing',
    description: 'read something',
    parameters: z.object({ key: z.string() }),
    approval: 'auto',
    execute: (args) => `read(${args.key})`,
  });
  h2.attachSession(s3);
  const messages = [{ role: 'user', content: 'hi' }];
  const writer = makeWriter();
  const llm = fakeStreamText([{ text: 'hello' }]);
  const res = await runLoopStreamSegment(h2, messages, { model: {}, store: s3, writer, messageId: 'm3c', streamTextCall: llm });
  assert.equal(res.finishReason, 'stop');
  const seq = (await eventsOf(s3)).map((e) => e.event);
  assert.deepEqual(seq, ['turn/start', 'turn/end'], `sequence: ${seq}`);
  const end = (await eventsOf(s3)).find((e) => e.event === 'turn/end');
  assert.deepEqual(end.payload, { finishReason: 'stop' });
  ok('lifecycle: text-only segment has turn/start + turn/end{stop} bracket');
}

// 3b. (lifecycle) auto tool closes its intervals: tool_call/start|end +
//     tool_result/start|end written in order, result fully landed.
{
  const messages = [{ role: 'user', content: 'do reads' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'c9', toolName: 'read_thing', args: { key: 'k' } }] },
    { text: 'done' },
  ]);
  const res = await runLoopStreamSegment(harness, messages, { model: {}, store, writer, messageId: 'm2b', streamTextCall: llm });
  assert.equal(res.finishReason, 'stop');
  const evs = (await eventsOf(store)).filter((e) => e.payload?.toolCallId === 'c9');
  const seq = evs.map((e) => e.event);
  assert.deepEqual(seq, ['tool_call/start', 'tool_call/end', 'tool_result/start', 'tool_result/end'], `interval order: ${seq}`);
  assert.deepEqual(evs[0].payload, { toolCallId: 'c9', toolName: 'read_thing', args: { key: 'k' }, expectsAnswer: false });
  assert.deepEqual(evs[1].payload, { toolCallId: 'c9', decision: 'approve' });
  assert.deepEqual(evs[2].payload, { toolCallId: 'c9' });
  assert.deepEqual(evs[3].payload, { toolCallId: 'c9' });
  ok('lifecycle: auto tool call/result intervals written with payloads, in order');
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
  assert.equal(await store.pendingToolCall(), null, 'store derives no pending after approve');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'tool');
  assert.equal(last.content[0].result, 'wrote(x)');
  ok('executeApprovedTool: approve runs the tool and streams its result');
}

// 4b. Deny closes the interval too (decision: deny) and leaves no pending;
//     the refusal still produces a tool_result interval.
{
  const s4 = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-deny' });
  await s4.create();
  const h4 = new Harness({ workspace: ws });
  h4.registerTool({
    name: 'write_thing',
    description: 'write something',
    parameters: z.object({ key: z.string() }),
    approval: 'ask',
    execute: (args) => `wrote(${args.key})`,
  });
  h4.attachSession(s4);
  const messages = [{ role: 'user', content: 'do writes' }];
  const writer = makeWriter();
  const llm = fakeStreamText([{ toolCalls: [{ toolCallId: 'wD', toolName: 'write_thing', args: { key: 'd' } }] }]);
  await runLoopStreamSegment(h4, messages, { model: {}, store: s4, writer, messageId: 'm4b', streamTextCall: llm });
  const writer2 = makeWriter();
  await executeApprovedTool(h4, messages, { toolCallId: 'wD', toolName: 'write_thing', args: { key: 'd' } }, 'deny', { store: s4, writer: writer2 });
  assert.equal(await s4.pendingToolCall(), null, 'deny closes the interval, no pending');
  const evs = await eventsOf(s4);
  const end = evs.find((e) => e.event === 'tool_call/end');
  assert.deepEqual(end.payload, { toolCallId: 'wD', decision: 'deny' });
  assert.ok(evs.some((e) => e.event === 'tool_result/start') && evs.some((e) => e.event === 'tool_result/end'), 'deny refusal still lands as a result interval');
  ok('lifecycle: deny closes the tool_call interval with decision deny');
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

// 5b. (#02) ask_user pause: pending carries expectsAnswer, card data part too.
{
  const messages = [{ role: 'user', content: 'ask me' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'a1', toolName: 'user_input', args: { question: 'which port?' } }] },
  ]);
  const res = await runLoopStreamSegment(harness, messages, {
    model: {},
    store,
    writer,
    messageId: 'm4b',
    streamTextCall: llm,
  });
  assert.equal(res.finishReason, 'tool-calls');
  const part = writer.lines.find((l) => l.includes('approval-pending'));
  assert.ok(part.includes('true'), 'approval-pending part carries expectsAnswer:true');
  const pend = await store.pendingToolCall();
  assert.equal(pend.expectsAnswer, true, 'open tool_call interval carries expectsAnswer');
  ok('ask_user pause: expectsAnswer flagged in data part + open interval');
}

// 5c. (#02) resume with answer: the answer IS the tool result, execute never
//     called; message sequence stays assistant(tool-call) → tool(result=answer).
{
  const messages = [{ role: 'user', content: 'ask me' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'a1', toolName: 'user_input', args: { question: 'which port?' } }] },
  ]);
  await runLoopStreamSegment(harness, messages, { model: {}, store: null, writer, messageId: 'm4c', streamTextCall: llm });
  userInputExecuted = false;
  const writer2 = makeWriter();
  await executeApprovedTool(
    harness,
    messages,
    { toolCallId: 'a1', toolName: 'user_input', args: { question: 'which port?' } },
    'approve',
    { store: null, writer: writer2 },
    undefined,
    'port 3010',
  );
  assert.equal(userInputExecuted, false, 'execute never called for answer');
  assert.ok(writer2.lines.some((l) => l.includes('port 3010')), 'answer streamed as tool result');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'tool');
  assert.equal(last.content[0].result, 'port 3010');
  assert.deepEqual(pendingToolCalls(messages), [], 'no pending after answering');
  ok('executeApprovedTool: approve-with-payload feeds the answer back, no execution');
}

// 5d. (#02 review) Stray answer on a NON-expectsAnswer tool is ignored — the
//     tool executes normally (no result forgery).
{
  const messages = [{ role: 'user', content: 'do writes' }];
  const writer = makeWriter();
  const llm = fakeStreamText([
    { toolCalls: [{ toolCallId: 'w9', toolName: 'write_thing', args: { key: 'q' } }] },
  ]);
  await runLoopStreamSegment(harness, messages, { model: {}, store: null, writer, messageId: 'm4d', streamTextCall: llm });
  const writer2 = makeWriter();
  await executeApprovedTool(
    harness,
    messages,
    { toolCallId: 'w9', toolName: 'write_thing', args: { key: 'q' } },
    'approve',
    { store: null, writer: writer2 },
    undefined,
    'forged answer',
  );
  assert.ok(writer2.lines.some((l) => l.includes('wrote(q)')), 'tool ran, answer ignored');
  const last = messages[messages.length - 1];
  assert.equal(last.content[0].result, 'wrote(q)');
  ok('executeApprovedTool: stray answer on plain tool ignored, tool executes');
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
  const s2 = new SessionStore({ baseDir: tmpRoot, workspace: ws, sessionId: 'sess-stream' });
  const loaded = await s2.load();
  const roles = loaded.messages.map((m) => m.role);
  assert.ok(roles.includes('assistant') && roles.includes('tool'));
  ok('session jsonl: assistant + tool lines persisted for replay');
}

// 8. reasoningProviderOptions: off/unsupported thread nothing; openai ↔ effort;
//    anthropic ↔ thinking budget scaled by level.
{
  assert.equal(reasoningProviderOptions('openai-completions', 'off'), undefined);
  assert.equal(reasoningProviderOptions('openai-responses', undefined), undefined);
  assert.equal(reasoningProviderOptions('some-other', 'high'), undefined);
  assert.deepEqual(reasoningProviderOptions('openai-completions', 'low'), {
    openai: { reasoningEffort: 'low' },
  });
  assert.deepEqual(reasoningProviderOptions('openai-responses', 'high'), {
    openai: { reasoningEffort: 'high' },
  });
  assert.deepEqual(reasoningProviderOptions('anthropic-messages', 'medium'), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
  });
  assert.deepEqual(reasoningProviderOptions('anthropic-messages', 'high'), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
  });
  ok('reasoningProviderOptions: off/unknown skip, openai→effort, anthropic→thinking budget');
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`stream-loop: ${passed} checks passed`);
