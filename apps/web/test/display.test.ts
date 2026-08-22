// Plain-node unit test for the web display layer (deepen #04). Pure
// functions/constants only — no React, no hooks, no 'use client' — so this
// runs with tsx and no browser/DOM.
import assert from 'node:assert/strict';
import {
  LEVEL_META,
  REASONING_META,
  REASONING_KEYS,
  MODES,
  toText,
  textOf,
  contextLimit,
  formatTokens,
  estimateUsage,
} from '../lib/display';

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ok - ${name}`);
}

// 1. Label constants are complete and stable.
{
  assert.deepEqual(Object.keys(LEVEL_META).sort(), ['fullaccess', 'readonly', 'workspace']);
  assert.equal(LEVEL_META.workspace.desc.length > 0, true, 'workspace has a description');
  assert.deepEqual(Object.keys(REASONING_META).sort(), ['high', 'low', 'medium', 'off']);
  assert.deepEqual(REASONING_KEYS.sort(), ['high', 'low', 'medium', 'off']);
  assert.deepEqual(MODES.map((m) => m.id).sort(), ['base', 'standard']);
  ok('label constants: LEVEL_META / REASONING_META / MODES complete');
}

// 2. toText (shared contract extractor) handles string + text parts.
{
  assert.equal(toText('plain'), 'plain');
  assert.equal(toText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  ok('toText: string + text parts');
}

// 3. textOf (display variant) serializes non-text parts as JSON.
{
  assert.equal(textOf('plain'), 'plain');
  assert.equal(
    textOf([
      { type: 'text', text: 'hi' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'bash', args: {} } as any,
    ]),
    'hi {"type":"tool-call","toolCallId":"t1","toolName":"bash","args":{}}',
  );
  ok('textOf: text parts plus JSON-serialized non-text parts');
}

// 4. contextLimit maps model ids to known tiers.
{
  assert.equal(contextLimit('claude-sonnet-4'), 200_000);
  assert.equal(contextLimit('gpt-4o-mini'), 128_000);
  assert.equal(contextLimit('some-32k-model'), 32_768);
  assert.equal(contextLimit('unknown'), 128_000); // default tier
  ok('contextLimit: claude/32k/128k tiers with default');
}

// 5. formatTokens compacts counts.
{
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5K');
  assert.equal(formatTokens(12000), '12K');
  assert.equal(formatTokens(1_200_000), '1.2M');
  ok('formatTokens: K/M compaction');
}

// 6. estimateUsage computes a clamped percent with per-part breakdowns.
{
  const msgs = [
    { role: 'user', content: 'hello world' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(4000) }, // ~1000 tokens at 4c/char
        { type: 'tool-call', toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } },
      ],
    },
  ];
  const u = estimateUsage(msgs, 'claude-sonnet-4');
  assert.equal(u.limit, 200_000);
  assert.equal(u.systemTokens, 1_000);
  assert.ok(u.messageTokens > 1000, `message tokens counted: ${u.messageTokens}`);
  assert.ok(u.toolTokens > 0, 'tool parts counted');
  assert.ok(u.tokens >= 2_000 && u.tokens <= 200_000, `tokens clamped in range: ${u.tokens}`);
  assert.ok(u.percent >= 1 && u.percent <= 100, `percent clamped: ${u.percent}`);
  // Clamp: a giant history pins to the limit.
  const huge = [{ role: 'user', content: 'x'.repeat(10_000_000) }];
  assert.equal(estimateUsage(huge, 'claude-sonnet-4').tokens, 200_000, 'clamped at the model limit');
  ok('estimateUsage: per-part breakdown, clamped tokens/percent');
}

console.log(`\ndisplay: ${passed} checks passed`);