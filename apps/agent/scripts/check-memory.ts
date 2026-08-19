// End-to-end check for the memory reference extension, driven without a real
// LLM/API key by injecting a fake `llmCall` into runLoop. Reproduces the real
// Harness + onion bus + built-in loop, and loads the memory extension from the
// local extensions/ directory via the auto-discovery loader (T02 + T04 joint).
import { Harness, bashTool, strReplaceEditorTool, denylistExtension, runLoop } from '@applepi/core';
import fs from 'node:fs/promises';
import path from 'node:path';

const harness = new Harness();

// Built-in tools + outermost denylist (same wiring as main.ts).
harness.registerExtension((api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
});
harness.registerExtension(denylistExtension);

// Memory extension arrives via the local loader (no manual registration).
const extDir = new URL('../extensions/', import.meta.url).pathname;
const loaded = await harness.loadExtensionsFromDir(extDir);
console.error(`[check-memory] auto-discovered: ${loaded.join(', ') || '(none)'}`);

const MEM_FILE = path.resolve('harness-memory.json');
await fs.rm(MEM_FILE, { force: true });

// Fake LLM: turn 1 writes, turn 2 reads, turn 3 stops.
let turn = 0;
const fakeLlm: any = async () => {
  turn++;
  if (turn === 1) {
    return {
      text: 'storing',
      toolCalls: [
        { toolCallId: 't1', toolName: 'memory_write', args: { key: 'project', value: 'harness' } },
      ],
    };
  }
  if (turn === 2) {
    return {
      text: 'recalling',
      toolCalls: [
        { toolCallId: 't2', toolName: 'memory_read', args: { key: 'project' } },
      ],
    };
  }
  return { text: 'done' };
};

const messages: any[] = [];
await runLoop(harness, messages, { model: {}, llmCall: fakeLlm, maxTurns: 6 });

// Pull the memory_read result out of the tool messages.
const readResult = messages
  .filter((m) => m.role === 'tool')
  .flatMap((m) => m.content)
  .find((c: any) => c?.toolName === 'memory_read')?.result;

const fileExists = await fs.stat(MEM_FILE).then(() => true).catch(() => false);
const fileContent = fileExists ? await fs.readFile(MEM_FILE, 'utf8') : '';

console.log('--- memory_read result:', readResult);
console.log('--- persisted file exists:', fileExists);
console.log('--- file content:', fileContent);

const okInSession = typeof readResult === 'string' && readResult.includes('harness');
const okPersisted = fileExists && fileContent.includes('harness');

await fs.rm(MEM_FILE, { force: true });

if (okInSession && okPersisted) {
  console.log('check-memory: OK');
} else {
  console.error('check-memory: FAIL');
  process.exit(1);
}
