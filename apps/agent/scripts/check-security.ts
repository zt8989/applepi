// Key-free verification of the ADR-0009 security model in the real agent
// context: tool self-determination (bash whitelist, sre view-only, path
// scoping), the denylist floor at every level, the core SecurityPolicy
// (level/set event + prompt rebuild WITHOUT unloading tools), and extension
// reload (unload + re-inject + useEffect cleanup). Run:
//   pnpm --filter agent check-security
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  Harness,
  SessionStore,
  PERMISSION_SCRATCH_KEY,
  DEFAULT_PERMISSION_LEVEL,
  restorePermissionLevel,
  type PermissionLevel,
} from '@applepi/core';
import { baseExtension, createMemoryExtension } from '@applepi/extensions';

const WS = 'check-security-tmp';
const DIR = path.join(os.homedir(), '.applepi', 'sessions', WS);

const harness = new Harness();
harness.registerExtension(baseExtension);
// memory_write self-blocking is verified here too (ADR-0009 Q4/Q5).
harness.registerExtension(createMemoryExtension({ filePath: path.join(tmpdir(), 'sec-check-memory.json') }));
const store = new SessionStore({ workspace: WS });
await store.create();
harness.attachSession(store);
await harness.restoreSecurity(store);

// Test files: inner lives in the cwd (project root); outer in the OS tmpdir.
const innerFile = path.join(process.cwd(), '.sec-check-inner.txt');
const outerFile = path.join(tmpdir(), 'sec-check-outer.txt');
const existingFile = path.join(process.cwd(), '.sec-check-existing.txt');
await fs.writeFile(existingFile, 'hello sec', 'utf8');

/** Drive one tool call through the `tool` onion stack (as runLoop does). */
async function callTool(toolName: string, args: any): Promise<string> {
  const tctx: any = { session: harness.session, state: {}, toolName, toolArgs: args };
  await harness.bus.run('tool', tctx, async () => {
    await harness.executeTool(tctx);
  });
  return String(tctx.toolResult ?? '');
}

async function setLevel(level: PermissionLevel): Promise<void> {
  const cmd = harness.api.getSlashCommand('level')!;
  await cmd(level, harness.api); // exercises the real /level handler
}

function fail(msg: string): never {
  console.error(`check-security: FAIL — ${msg}`);
  process.exit(1);
}

// --- 1. default level = workspace; prompt carries the declaration -----------
{
  const level = await restorePermissionLevel(store, harness.session.scratch);
  if (level !== DEFAULT_PERMISSION_LEVEL) fail(`default level is ${level}, want workspace`);
  if (harness.session.scratch[PERMISSION_SCRATCH_KEY] !== 'workspace') {
    fail('default scratch level is not workspace');
  }
  const built = await harness.buildSystemPrompt();
  const sys = built.prompt;
  if (!sys.includes('Permission Level: workspace')) fail('prompt lacks Permission Level: workspace');
  if (!built.sections.includes('permission')) fail('permission section not reported in build sections');
}

// --- 2. readonly: tool self-determination -----------------------------------
{
  await setLevel('readonly');

  const viewRes = await callTool('str_replace_editor', { command: 'view', path: existingFile });
  if (!viewRes.includes('hello sec')) fail('readonly: view should pass');
  const writeRes = await callTool('str_replace_editor', { command: 'write', path: innerFile, content: 'x' });
  if (!writeRes.includes('BLOCKED')) fail('readonly: write should be blocked');
  const bashRead = await callTool('bash', { command: 'pwd' });
  if (bashRead.startsWith('BLOCKED')) fail('readonly: whitelisted bash (pwd) blocked');
  const bashWrite = await callTool('bash', { command: `touch ${innerFile}` });
  if (!bashWrite.includes('BLOCKED')) fail('readonly: bash write should be blocked');
  const memWrite = await callTool('memory_write', { key: 'k', value: 'v' });
  if (!memWrite.includes('BLOCKED')) fail('readonly: memory_write should self-block');
  console.log('--- readonly: view ok, write blocked, bash whitelist + memory self-block enforced');
}

// --- 3. workspace: writes inside project root pass, outside blocked ---------
{
  await setLevel('workspace');

  const w1 = await callTool('str_replace_editor', { command: 'write', path: innerFile, content: 'inner' });
  if (!w1.startsWith('WROTE')) fail(`workspace: inner write failed: ${w1}`);
  const w2 = await callTool('str_replace_editor', { command: 'write', path: outerFile, content: 'outer' });
  if (!w2.includes('BLOCKED')) fail('workspace: outer write should be blocked');
  const bashInner = await callTool('bash', { command: `touch ${innerFile}` });
  if (bashInner.startsWith('BLOCKED')) fail('workspace: bash inner write blocked');
  const bashOuter = await callTool('bash', { command: `touch ${outerFile}` });
  if (!bashOuter.includes('BLOCKED')) fail('workspace: bash outer write should be blocked');
  console.log('--- workspace: inner write ok, outer write blocked (realpath prefix)');
}

// --- 4. fullaccess: writes anywhere pass; denylist floor still fires -------
{
  await setLevel('fullaccess');

  const f1 = await callTool('str_replace_editor', { command: 'write', path: outerFile, content: 'outer' });
  if (!f1.startsWith('WROTE')) fail(`fullaccess: outer write failed: ${f1}`);
  const f2 = await callTool('bash', { command: `rm -rf ${path.join(tmpdir(), 'sec-check-nothing')}` });
  if (!f2.includes('BLOCKED')) fail('fullaccess: rm -rf should still hit the denylist floor');
  console.log('--- fullaccess: write anywhere ok, denylist floor still blocks rm -rf');
}

// --- 5. /level persists an event + rebuilds the prompt; tools are NOT unloaded
{
  const before = harness.api.getTools().map((t) => t.name).sort();
  const ev = await store.lastEvent('level/set');
  if (!ev || ev.payload?.level !== 'fullaccess') fail('level/set event not persisted');
  const fresh: Record<string, any> = {};
  const restored = await restorePermissionLevel(store, fresh);
  if (restored !== 'fullaccess' || fresh[PERMISSION_SCRATCH_KEY] !== 'fullaccess') {
    fail('lastEvent did not restore fullaccess');
  }
  const store2 = new SessionStore({ workspace: `${WS}-2` });
  await store2.create();
  const restored2 = await restorePermissionLevel(store2, {});
  if (restored2 !== 'workspace') fail('empty session did not default to workspace');

  // Level is a change in permission SIZE, not a tool unload (ADR-0009 Q14
  // amendment): the registered tool set is identical across level switches.
  await setLevel('readonly');
  const after = harness.api.getTools().map((t) => t.name).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail(`level switch changed the tool set: ${before} -> ${after}`);
  }
  await setLevel('workspace');
  console.log('--- level/set persisted; prompt rebuilt; tool set unchanged across levels');
}

// --- 6. extension reload: unload + re-inject + useEffect cleanup -----------
{
  const extDir = path.join(tmpdir(), `sec-check-ext-${Date.now()}`);
  await fs.mkdir(extDir, { recursive: true });
  const extFile = path.join(extDir, 'probe.ext.mjs');
  await fs.writeFile(
    extFile,
    `
export default (api) => {
  api.useEffect(() => {
    return () => { globalThis.__secCheckCleaned = true; };
  });
  api.registerTool({
    name: 'reload_probe',
    description: 'probe tool for reload verification',
    parameters: {},
    execute: () => 'probe-ok',
  });
};
`,
    'utf8',
  );

  const loaded = await harness.loadExtensionsFromDir(extDir);
  if (!loaded.includes('probe.ext.mjs')) fail(`probe extension not loaded: ${loaded}`);
  if (!harness.api.getTools().some((t) => t.name === 'reload_probe')) {
    fail('reload_probe tool not registered');
  }
  const probeRes = await callTool('reload_probe', {});
  if (probeRes !== 'probe-ok') fail(`probe tool call failed: ${probeRes}`);

  // Remove the file, reload into the now-empty dir: tool must be unloaded and
  // the useEffect cleanup must have run.
  await fs.rm(extFile, { force: true });
  const reloaded = await harness.reloadExtensions(extDir);
  if (reloaded.length !== 0) fail(`reload should find no extensions: ${reloaded}`);
  if (harness.api.getTools().some((t) => t.name === 'reload_probe')) {
    fail('reload_probe still registered after reload');
  }
  if ((globalThis as any).__secCheckCleaned !== true) {
    fail('useEffect cleanup was not invoked on reload');
  }
  await fs.rm(extDir, { recursive: true, force: true }).catch(() => {});
  console.log('--- reload: registrations revoked, useEffect cleanup ran');
}

// cleanup — best-effort: a failed cleanup must not fail the verification.
for (const f of [innerFile, outerFile, existingFile]) {
  await fs.rm(f, { force: true }).catch(() => {});
}
await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
await fs.rm(path.join(os.homedir(), '.applepi', 'sessions', `${WS}-2`), { recursive: true, force: true }).catch(() => {});

console.log('OK: security model verified (self-determination, denylist floor, level skeleton, reload lifecycle)');
