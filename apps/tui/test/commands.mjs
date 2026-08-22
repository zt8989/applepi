// Pure-function tests for the TUI slash-command mapping (ticket 08).
// No Ink, no server — plain node.
import assert from 'node:assert/strict';
import { parseCommand } from '../dist/utils.js';

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

// 1. The six core commands map; non-slash lines are ordinary chat.
{
  assert.deepEqual(parseCommand('/new'), { type: 'new' });
  assert.deepEqual(parseCommand('/new standard'), { type: 'new', mode: 'standard' });
  assert.deepEqual(parseCommand('/new base'), { type: 'new', mode: 'base' });
  assert.deepEqual(parseCommand('/resume abc-123'), { type: 'resume', id: 'abc-123' });
  assert.deepEqual(parseCommand('/sessions'), { type: 'sessions' });
  assert.deepEqual(parseCommand('/config'), { type: 'config' });
  assert.deepEqual(parseCommand('/level readonly'), { type: 'level', level: 'readonly' });
  assert.deepEqual(parseCommand('/level fullaccess'), { type: 'level', level: 'fullaccess' });
  assert.deepEqual(parseCommand('/help'), { type: 'help' });
  assert.deepEqual(parseCommand('/exit'), { type: 'exit' });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand(''), null);
  ok('commands: six core commands map, plain lines stay chat', true);
}

// 2. Invalid forms degrade to error with a concrete message, never throw.
{
  assert.equal(parseCommand('/new weird').type, 'error');
  assert.equal(parseCommand('/resume').type, 'error');
  assert.equal(parseCommand('/level nope').type, 'error');
  assert.equal(parseCommand('/unknown-cmd').type, 'error');
  ok('commands: invalid forms map to error', true);
}

console.log(`\ncommands: ${passed} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);