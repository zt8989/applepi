import { createInterface } from 'node:readline/promises';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import {
  Harness,
  SessionStore,
  bashTool,
  strReplaceEditorTool,
  denylistExtension,
} from '@applepi/core';

const extDir = new URL('../extensions/', import.meta.url).pathname;

/** Base system-prompt section contributed by the agent (Q10=c). */
function buildBaseSystemPrompt(): string {
  return [
    'You are a minimal local agent harness.',
    'You have two built-in tools: `bash` and `str_replace_editor`.',
    'Use them to accomplish the user\'s request step by step.',
  ].join('\n');
}

function pickModel(): any {
  const provider = process.env.LLM_PROVIDER ?? 'openai';
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    return anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-latest');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }
  return openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
}

/** Build a fully-wired Harness: built-ins + denylist + extensions + base contributor. */
async function boot(store: SessionStore): Promise<{ harness: Harness; loaded: string[] }> {
  const harness = new Harness();
  harness.registerExtension((api) => {
    api.registerTool(bashTool);
    api.registerTool(strReplaceEditorTool);
  });
  harness.registerExtension(denylistExtension);
  harness.registerExtension((api) =>
    api.addSystemPromptContributor(() => buildBaseSystemPrompt(), 'base'),
  );
  const loaded = await harness.loadExtensionsFromDir(extDir);
  harness.attachSession(store);
  return { harness, loaded };
}

function printMessages(messages: any[]): void {
  for (const m of messages) {
    console.log(`\n=== ${m.role} ===`);
    const c: any = m.content;
    if (typeof c === 'string') {
      console.log(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part.type === 'text') console.log(part.text);
        else if (part.type === 'tool-call') {
          console.log(`  [tool call] ${part.toolName}(${JSON.stringify(part.args)})`);
        } else if (part.type === 'tool-result') {
          console.log(`  [tool result] ${String(part.result).slice(0, 200)}`);
        }
      }
    } else {
      console.log(JSON.stringify(c, null, 2));
    }
  }
}

const HELP = [
  'Commands:',
  '  /reload          re-scan extensions/ and rebuild the system prompt',
  '  /resume <id>     switch to and continue session <id>',
  '  /new             start a fresh session',
  '  /sessions        list sessions in this workspace',
  '  /help            show this help',
  '  /exit            quit (or Ctrl-D)',
].join('\n');

const model = pickModel();
let store = new SessionStore();
await store.create();
console.log(`[session] ${store.sessionId} (workspace: ${store.workspace})`);

let { harness, loaded } = await boot(store);
if (loaded.length) console.error(`[harness] loaded local extensions: ${loaded.join(', ')}`);

// Fresh session: persist the initial system prompt once.
await harness.emitSystemPrompt();
console.log(`[system] system prompt built (sections: ${harness.contributorSections().join(', ')})`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
const initial = process.argv[2];

async function handleTurn(input: string): Promise<void> {
  const messages = await harness.run(input, model, { emitSystemPrompt: false });
  printMessages(messages.filter((m) => m.role !== 'system'));
  rl.prompt();
}

async function runInitial(): Promise<void> {
  if (initial) {
    await handleTurn(initial);
    rl.prompt();
  } else {
    rl.prompt();
  }
}

rl.on('line', async (raw) => {
  const line = raw.trim();
  if (!line) {
    rl.prompt();
    return;
  }

  if (line.startsWith('/')) {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/reload': {
        const oldScratch = harness.session.scratch;
        const oldHistory = harness.session.history;
        await store.appendEvent('reload', 'start', { extensionsDiscovered: loaded, reset: true });
        ({ harness, loaded } = await boot(store));
        harness.session.scratch = oldScratch;
        harness.session.history = oldHistory;
        await harness.emitSystemPrompt();
        await store.appendEvent('reload', 'end', { extensionsDiscovered: loaded, reset: true });
        console.log(`[reload] extensions re-scanned (${loaded.length}), system prompt rebuilt`);
        break;
      }
      case '/resume': {
        if (!arg) {
          console.log('usage: /resume <session_id>');
          break;
        }
        ({ harness } = await boot(store));
        store = await harness.resume(arg);
        console.log(`[resume] active session -> ${store.sessionId}`);
        break;
      }
      case '/new': {
        store = new SessionStore();
        await store.create();
        ({ harness, loaded } = await boot(store));
        await harness.emitSystemPrompt();
        console.log(`[new] session ${store.sessionId}`);
        break;
      }
      case '/sessions': {
        const ids = await harness.listSessions();
        console.log(ids.length ? ids.join('\n') : '(no sessions yet)');
        break;
      }
      case '/help':
        console.log(HELP);
        break;
      case '/exit':
        rl.close();
        return;
      default:
        console.log(`unknown command: ${cmd} (try /help)`);
    }
    rl.prompt();
    return;
  }

  await handleTurn(line);
});

await runInitial();
