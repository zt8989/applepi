// Key-free unit test for @applepi/bundle (ADR-0015).
// Verifies the declarative capability model:
//   - base  = EXACTLY bash + str_replace_editor, no capabilities
//   - standard = full capability complement, reuses shared tool impls, own
//     prompt
//   - base & standard are SIBLINGS (no inheritance / no `extends`), distinct
//     names + prompts
//   - getBundle / makeBundleSpec resolve correctly
import assert from 'node:assert/strict';
import {
  baseBundle,
  standardBundle,
  BUNDLES,
  getBundle,
  makeBundleSpec,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const env = { cwd: '/workspace/applepi', workspace: '/workspace/applepi' };

// 1. base = exactly two tools, zero capabilities.
{
  const spec = baseBundle.make(env);
  const names = spec.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['bash', 'str_replace_editor'], 'base has exactly bash + sre');
  assert.equal(spec.capabilities.length, 0, 'base has no app-assembled capabilities');
  assert.ok(spec.prompt.length >= 1, 'base has at least one prompt fragment');
  assert.ok(spec.prompt.some((p) => p.includes('str_replace_editor')), 'base permission fragment names its tools');
  ok('base = exactly {bash, sre}, no capabilities');
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
  ok('standard = full capability complement + shared tools');
}

// 3. Siblings: no inheritance, no extends, distinct prompts.
{
  const b = baseBundle.make(env);
  const s = standardBundle.make(env);
  assert.notEqual(baseBundle.name, standardBundle.name);
  assert.equal(typeof baseBundle.extends, 'undefined', 'base has no extends');
  assert.equal(typeof standardBundle.extends, 'undefined', 'standard has no extends');
  assert.notEqual(s.prompt[0], b.prompt[0], 'standard does not reuse base persona fragment');
  // standard is NOT base + base's fragments (self-contained own prompt).
  const joined = s.prompt.join('\n');
  assert.ok(!joined.includes(b.prompt[0]), 'standard prompt does not contain base persona');
  ok('base & standard are siblings (no extends, no inherited prompt)');
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

console.log(`\nbundle: ${passed} checks passed`);
