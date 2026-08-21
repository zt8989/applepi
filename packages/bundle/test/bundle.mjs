// Key-free unit test for @applepi/bundle (ADR-0015 + deepen-architecture #01).
// Verifies the declarative capability model and prompt honesty:
//   - base  = EXACTLY bash + str_replace_editor, no capabilities
//   - standard = full capability complement, reuses shared tool impls
//   - base & standard are SIBLINGS (no inheritance / no `extends`)
//   - getBundle / makeBundleSpec resolve correctly
//   - (deepen #01) the assembled prompt lists ONLY actually-wired tools; no
//     unwired web/todo/subagent/workflow claims; enableBundleSpec warns on
//     declared-but-unwired ids; prompt tool set == harness registered set.
import assert from 'node:assert/strict';
import { Harness } from '@applepi/core';
import {
  baseBundle,
  standardBundle,
  BUNDLES,
  getBundle,
  makeBundleSpec,
  assembleFlatPrompt,
  enableBundleSpec,
  STANDARD_PROMPT,
  BASE_PROMPT,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const env = { cwd: '/workspace/applepi', workspace: '/workspace/applepi' };

function freshHarness() {
  const h = new Harness({ workspace: 'test-ws' });
  h.session.config.workspace = '/workspace/applepi';
  return h;
}

// 1. base = exactly two tools, zero capabilities, minimal persona only.
{
  const spec = baseBundle.make(env);
  const names = spec.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['bash', 'str_replace_editor'], 'base has exactly bash + sre');
  assert.equal(spec.capabilities.length, 0, 'base has no app-assembled capabilities');
  // (deepen #01) the spec carries NO permission fragment — the shared
  // permissionFragment is injected at assembly time from the resolved tools.
  assert.deepEqual(spec.prompt, [BASE_PROMPT], 'base spec prompt is the persona only');
  ok('base = exactly {bash, sre}, no capabilities, persona-only spec prompt');
}

// 2. standard = full complement, reuses shared bash+sre, own prompt.
{
  const spec = standardBundle.make(env);
  const names = spec.tools.map((t) => t.name).sort();
  assert.ok(names.includes('bash') && names.includes('str_replace_editor'),
    'standard reuses shared bash/sre implementations');
  for (const cap of ['memory', 'skills', 'web', 'plan', 'goal', 'subagent', 'workflow', 'todo', 'ask_user']) {
    assert.ok(spec.capabilities.includes(cap), `standard capability missing: ${cap}`);
  }
  assert.deepEqual(spec.prompt, [STANDARD_PROMPT], 'standard spec prompt is the (minimal) persona only');
  ok('standard = full capability complement + shared tools');
}

// 3. Siblings: no inheritance, no extends, distinct names.
{
  const b = baseBundle.make(env);
  const s = standardBundle.make(env);
  assert.notEqual(baseBundle.name, standardBundle.name);
  assert.equal(typeof baseBundle.extends, 'undefined', 'base has no extends');
  assert.equal(typeof standardBundle.extends, 'undefined', 'standard has no extends');
  // (deepen #01) both bundles now share the minimal persona — the old "own
  // distinct prompt" assertions are gone; the prompt honesty contract moved
  // to the assembled permission fragment (tests 6-7 below).
  assert.equal(b.prompt[0], BASE_PROMPT);
  assert.equal(s.prompt[0], STANDARD_PROMPT);
  ok('base & standard are siblings (no extends, shared minimal persona)');
}

// 4. Registry / resolver.
{
  assert.deepEqual(Object.keys(BUNDLES).sort(), ['base', 'standard']);
  assert.equal(getBundle('base').name, 'base');
  assert.equal(getBundle('standard').name, 'standard');
  assert.equal(getBundle('nope'), undefined);
  const made = makeBundleSpec('base', env);
  assert.deepEqual(made.tools.map((t) => t.name).sort(), ['bash', 'str_replace_editor']);
  assert.equal(makeBundleSpec('nope'), undefined);
  ok('registry + getBundle/makeBundleSpec resolve base & standard');
}

// 5. Both bundles are pure declarations (no core/onion side effects): they
//    only return prompt + tools.
{
  for (const b of Object.values(BUNDLES)) {
    const spec = b.make(env);
    assert.deepEqual(Object.keys(spec).sort(), ['capabilities', 'prompt', 'tools'],
      `bundle ${b.name} spec has only declarative fields`);
  }
  ok('bundles are pure declarative specs (prompt + tools + capabilities only)');
}

// 6. (deepen #01 - a) Assembled prompt lists only real tools, no unwired
//    capability names. standard's web/todo/subagent/workflow/ask_user ids
//    have no factory yet → they must NOT appear in the prompt.
{
  const h = freshHarness();
  const spec = standardBundle.make(env);
  enableBundleSpec(h, spec);
  const prompt = assembleFlatPrompt(h, spec, { app: ['app fragment'] });
  // Landed tools are listed.
  for (const tool of ['bash', 'str_replace_editor', 'memory_read', 'memory_write', 'skill_load']) {
    assert.ok(prompt.includes(tool), `assembled standard prompt lists landed tool: ${tool}`);
  }
  // Declared-but-unwired names are absent.
  for (const unwired of ['web search', 'todo', 'subagent', 'workflow', 'ralph', 'ask_user', 'plan mode']) {
    assert.ok(!prompt.includes(unwired), `assembled standard prompt does not claim unwired: ${unwired}`);
  }
  assert.ok(prompt.includes('## Permission & Capability'), 'shared permission section present');
  assert.ok(prompt.includes('Project root: /workspace/applepi'), 'shared project root present');
  ok('(a) prompt lists only real tools, no unwired capability names');
}

// 7. (deepen #01 - b) No legacy full-capability persona text / old standard
//    permission fragment strings remain in the assembled prompt.
{
  const h = freshHarness();
  const spec = standardBundle.make(env);
  enableBundleSpec(h, spec);
  const prompt = assembleFlatPrompt(h, spec);
  assert.ok(!prompt.includes('You are a coding agent with the full capability set'),
    'no legacy full-capability persona text');
  assert.ok(!prompt.includes('Capabilities: memory, skills, web, plan mode'),
    'no legacy capability-list line');
  assert.ok(!prompt.includes('Tools: bash, str_replace_editor, memory_read/memory_write, skill_load, web search'),
    'no legacy hardcoded tool line');
  ok('(b) no legacy full-capability persona / hardcoded tool text');
}

// 8. (deepen #01 - c) enableBundleSpec warns on declared-but-unwired ids.
{
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const h = freshHarness();
    enableBundleSpec(h, standardBundle.make(env));
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warns.length > 0, 'enableBundleSpec(standard) emitted at least one warn');
  assert.ok(warns.some((w) => w.includes('web')), 'warn names an unwired id (web)');
  assert.ok(warns.some((w) => w.includes('ask_user')), 'warn names an unwired id (ask_user)');
  ok(`(c) enableBundleSpec warns on declared-but-unwired ids (${warns.length} warns)`);
}

// 9. (deepen #01 - d) Prompt tool set == harness registered set (drift guard).
{
  const h = freshHarness();
  const spec = standardBundle.make(env);
  enableBundleSpec(h, spec);
  const prompt = assembleFlatPrompt(h, spec);
  const listed = [...prompt.matchAll(/Tools available: ([^\n.]+)/g)][0]?.[1]
    .split(',')
    .map((s) => s.trim());
  const registered = h.getTools().map((t) => t.name).sort();
  assert.deepEqual([...listed].sort(), registered,
    'prompt "Tools available:" set equals the harness registered set');
  ok('(d) prompt tool set == actually-registered tool set (no drift)');
}

console.log(`\nbundle: ${passed} checks passed`);