// Pure-function tests for the TUI data-stream decoder + turn folding
// (ADR-0017 R2Q6). No Ink, no server — plain node.
import assert from 'node:assert/strict';
import { StreamLineDecoder } from '../dist/stream-parser.js';
import { emptyTurn, foldParts, awaitingApproval } from '../dist/utils.js';

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

// 1. Each wire prefix parses to its kind.
{
  const d = new StreamLineDecoder();
  const parts = d.push('0:"hello"\n2:[{"type":"session","sessionId":"s1"}]\n9:{"toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}\na:{"toolCallId":"t1","result":"ok"}\nd:{"finishReason":"stop"}\n3:"boom"\n');
  assert.deepEqual(parts.map((p) => p.type), ['text', 'data', 'tool-call', 'tool-result', 'finish', 'error']);
  assert.equal(parts[0].text, 'hello');
  assert.equal(parts[1].values[0].sessionId, 's1');
  assert.equal(parts[4].value.finishReason, 'stop');
  ok('parser: six prefixes decode to typed parts', parts.length === 6);
}

// 2. Partial lines buffer across chunks; CR stripped.
{
  const d = new StreamLineDecoder();
  assert.deepEqual(d.push('0:"hel'), [], 'partial line yields nothing yet');
  assert.equal(d.remainder, '0:"hel');
  const parts = d.push('lo"\r\n2:[{"type":"session","sessionId":"s2"}]');
  assert.equal(parts[0].text, 'hello');
  const rest = d.push('\n');
  assert.equal(rest[0].values[0].sessionId, 's2');
  ok('parser: half-line buffering + CRLF tolerance', parts.length === 1 && rest.length === 1);
}

// 3. Garbage / unknown prefixes are tolerated.
{
  const d = new StreamLineDecoder();
  const parts = d.push('nope\nx:{"un":1}\n');
  assert.equal(parts[0].type, 'unknown');
  assert.equal(parts[1].type, 'unknown');
  ok('parser: malformed lines degrade to unknown, never throw', parts.length === 2);
}

// 4. Fold: session + text accumulate; tool-result attaches by id.
{
  let view = emptyTurn();
  view = foldParts(view, [
    { type: 'data', values: [{ type: 'session', sessionId: 'abc' }] },
    { type: 'text', text: 'He' },
    { type: 'text', text: 'llo' },
    { type: 'tool-call', toolCallId: 't', toolName: 'bash', args: { command: 'ls' } },
  ]);
  assert.equal(view.sessionId, 'abc');
  assert.equal(view.text, 'Hello');
  assert.equal(view.toolCalls.length, 1);
  ok('fold: session + text accumulation', view.text === 'Hello' && view.sessionId === 'abc');
}

// 5. Pending detection: the unresolved tool call is the approval surface;
//    a data part re-surfaces it with expectsAnswer; a result clears it.
{
  let view = emptyTurn();
  view = foldParts(view, [
    { type: 'tool-call', toolCallId: 'a1', toolName: 'ask_user', args: { question: 'q?' } },
  ]);
  assert.equal(awaitingApproval(view).toolCallId, 'a1');
  view = foldParts(view, [
    { type: 'data', values: [{ type: 'approval-pending', toolCallId: 'a1', toolName: 'ask_user', expectsAnswer: true }] },
  ]);
  assert.equal(view.pending.expectsAnswer, true);
  view = foldParts(view, [
    { type: 'tool-result', toolCallId: 'a1', result: 'port 3210' },
  ]);
  assert.equal(awaitingApproval(view), null, 'result clears the approval surface');
  ok('fold: approval surface + expectsAnswer + resolution', view.pending === null);
}

console.log(`\nstream-parser: ${passed} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);