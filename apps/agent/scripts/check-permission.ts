// Key-free verification of the permission-level system (ADR-0007) in the real
// agent context (Harness + onion bus + baseExtension). A fake LLM is NOT needed:
// we drive tool calls through the `tool` stack directly, exactly as the loop
// would, and inspect results. Run:
//   pnpm --filter agent check-permission
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  Harness,
  SessionStore,
} from '@applepi/core';
import {
  baseExtension,
  restorePermissionLevel,
  PERMISSION_SCRATCH_KEY,
  DEFAULT_PERMISSION_LEVEL,
  type PermissionLevel,
} from '@applepi/extensions';

const WS = 'check-permission-tmp';
const DIR = path.join(os.homedir(), '.applepi', 'sessions', WS);

const harness = new Harness();
harness.registerExtension(baseExtension);
const store = new SessionStore({ workspace: WS });
await store.create();
harness.attachSession(store);

// Test file lives in the cwd (project root) — the harness writes real files.
const innerFile = path.join(process.cwd(), '.perm-check-inner.txt');
const outerFile = path.join(tmpdir(), 'perm-check-outer.txt');
const existingFile = path.join(process.cwd(), '.perm-check-existing.txt');

async function writeExisting(): Promise<void> {
  await fs.writeFile(existingFile, 'hello perm', 'utf8');
}
await writeExisting();

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
  console.error(`check-permission: FAIL — ${msg}`);
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
  console.log('--- default system prompt section:');
  console.log(sys.split('\n').filter((l) => l.startsWith('Permission Level') || l.includes('WORKSPACE')).join('\n'));
  if (!sys.includes('Permission Level: workspace')) fail('prompt lacks Permission Level: workspace');
  if (!built.sections.includes('permission')) fail('permission section not reported in build sections');
}

// --- 2. readonly: write blocked, view allowed, whitelist bash allowed -------
{
  await setLevel('readonly');

  const defs = harness.buildToolDefs();
  if (!defs.bash.description.includes('read-only')) fail('readonly: bash def not cropped');
  const sreParams: any = defs.str_replace_editor.parameters;
  if (sreParams.shape.command._def.typeName !== 'ZodLiteral') {
    fail('readonly: str_replace_editor command not cropped to literal view');
  }

  const viewRes = await callTool('str_replace_editor', { command: 'view', path: existingFile });
  if (!viewRes.includes('hello perm')) fail('readonly: view should pass');
  const writeRes = await callTool('str_replace_editor', { command: 'write', path: innerFile, content: 'x' });
  if (!writeRes.includes('BLOCKED')) fail('readonly: write should be blocked');
  const bashRead = await callTool('bash', { command: 'pwd' });
  if (bashRead.startsWith('BLOCKED')) fail('readonly: whitelisted bash (pwd) blocked');
  const bashWrite = await callTool('bash', { command: `touch ${innerFile}` });
  if (!bashWrite.includes('BLOCKED')) fail('readonly: bash write should be blocked');
  console.log('--- readonly: view ok, write blocked, bash whitelist enforced');
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
  const f2 = await callTool('bash', { command: `rm -rf ${path.join(tmpdir(), 'perm-check-nothing')}` });
  if (!f2.includes('BLOCKED')) fail('fullaccess: rm -rf should still hit the denylist floor');
  console.log('--- fullaccess: write anywhere ok, denylist floor still blocks rm -rf');
}

// --- 5. /level persists a level/set event; lastEvent restores it -----------
{
  const ev = await store.lastEvent('level/set');
  if (!ev || ev.payload?.level !== 'fullaccess') fail('level/set event not persisted');
  const fresh: Record<string, any> = {};
  const restored = await restorePermissionLevel(store, fresh);
  if (restored !== 'fullaccess' || fresh[PERMISSION_SCRATCH_KEY] !== 'fullaccess') {
    fail('lastEvent did not restore fullaccess');
  }
  // A missing event falls back to workspace.
  const store2 = new SessionStore({ workspace: `${WS}-2` });
  await store2.create();
  const restored2 = await restorePermissionLevel(store2, {});
  if (restored2 !== 'workspace') fail('empty session did not default to workspace');
  console.log('--- level/set event persisted; lastEvent restore verified');
}

// cleanup
for (const f of [innerFile, outerFile, existingFile]) {
  await fs.rm(f, { force: true });
}
await fs.rm(DIR, { recursive: true, force: true });
await fs.rm(path.join(os.homedir(), '.applepi', 'sessions', `${WS}-2`), { recursive: true, force: true });

console.log('OK: permission-level system verified (default/readonly/workspace/fullaccess, tool cropping, prompt declaration, level/set persistence)');
