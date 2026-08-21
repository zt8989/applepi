// Plain-node unit test for the shared message contract (deepen #03).
// Covers: toText (string + parts), mergeToolResults (tool -> owning
// assistant tool-call part), pendingApproval (pause/resume re-surface).
// Pure functions — no React, no AI SDK, no file I/O.
import assert from 'node:assert/strict';
import {
  toText,
  mergeToolResults,
  pendingApproval,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// 1. toText extracts plain text from a string or text parts.
{
  assert.equal(toText('plain hello'), 'plain hello');
  assert.equal(toText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(
    toText([{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }]),
    'answer',
  );
  assert.equal(toText([{ type: 'tool-call', toolCallId: 't1', toolName: 'bash', args: {} }]), '');
  assert.equal(toText(null), '');
  assert.equal(toText(undefined), '');
  ok('toText: string + text-parts extraction, ignores non-text parts');
}

// 2. mergeToolResults folds an assistant message's tool-call and the tool
//    result into one assistant message (result attached to the tool-call part).
{
  const inMsgs = [
    { role: 'assistant', content: [
      { type: 'text', text: 'running' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'bash', result: 'file.txt' },
    ] },
  ];
  const out = mergeToolResults(inMsgs);
  assert.equal(out.length, 1, 'tool message folded into assistant');
  const toolCall = out[0].content.find((p) => p.type === 'tool-call');
  assert.equal(toolCall.result, 'file.txt', 'result attached to the tool-call part');
  assert.equal(toolCall.isError, false);
  assert.equal(out[0].content.length, 2, 'assistant keeps text + tool-call parts');
  ok('mergeToolResults: tool result folds into the owning tool-call part');
}

// 3. mergeToolResults marks ERROR/BLOCKED results as errors.
{
  const inMsgs = [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'e1', toolName: 'bash', args: {} },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'e1', toolName: 'bash', result: 'ERROR: boom' },
    ] },
  ];
  const out = mergeToolResults(inMsgs);
  const toolCall = out[0].content.find((p) => p.type === 'tool-call');
  assert.equal(toolCall.isError, true, 'ERROR result flagged as error');
  ok('mergeToolResults: ERROR/BLOCKED result -> isError true');
}

// 4. mergeToolResults only attaches to the MOST RECENT matching tool-call;
//    a tool result with no owning tool-call is dropped (no ghost row).
{
  const inMsgs = [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'a1', toolName: 'bash', args: {} },
      { type: 'tool-call', toolCallId: 'b2', toolName: 'bash', args: {} },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'a1', toolName: 'bash', result: 'R1' },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'b2', toolName: 'bash', result: 'R2' },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'ghost', toolName: 'bash', result: 'G' },
    ] },
  ];
  const out = mergeToolResults(inMsgs);
  const calls = out[0].content.filter((p) => p.type === 'tool-call');
  assert.equal(calls.length, 2, 'both tool-calls stay');
  assert.equal(calls.find((c) => c.toolCallId === 'a1').result, 'R1');
  assert.equal(calls.find((c) => c.toolCallId === 'b2').result, 'R2');
  assert.equal(out.length, 1, 'orphan tool message dropped, no ghost row');
  ok('mergeToolResults: per-call attach, orphan tool results dropped');
}

// 5. mergeToolResults leaves user/system/plain messages untouched.
{
  const inMsgs = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
  ];
  const out = mergeToolResults(inMsgs);
  assert.deepEqual(out, inMsgs);
  ok('mergeToolResults: non-tool messages pass through unchanged');
}

// 6. pendingApproval surfaces the most recent unresolved tool-call (the
//    pause/resume re-surface used by web hydrate).
{
  const doneMsgs = [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'x1', toolName: 'bash', args: { cmd: 'ls' }, result: 'ok' },
    ] },
  ];
  assert.equal(pendingApproval(doneMsgs), null, 'resolved call -> no pending');

  const pendingMsgs = [
    { role: 'assistant', content: [
      { type: 'text', text: 'asking' },
      { type: 'tool-call', toolCallId: 'p1', toolName: 'str_replace_editor', args: { path: '/a' } },
    ] },
  ];
  const p = pendingApproval(pendingMsgs);
  assert.deepEqual(p, { toolCallId: 'p1', toolName: 'str_replace_editor', args: { path: '/a' } });
  ok('pendingApproval: unresolved tool-call re-surfaces with id/name/args');
}

// 7. pendingApproval looks only at the latest assistant message and ignores
//    older already-resolved turns.
{
  const msgs = [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'old', toolName: 'bash', args: {} },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'old', toolName: 'bash', result: 'done' },
    ] },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'fresh', toolName: 'bash', args: { cmd: 'pwd' } },
    ] },
  ];
  const p = pendingApproval(msgs);
  assert.equal(p?.toolCallId, 'fresh', 'latest unresolved call wins');
  ok('pendingApproval: resolves against the newest assistant message');
}

console.log(`\nmessage: ${passed} checks passed`);