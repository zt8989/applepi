import { createInterface } from 'node:readline/promises';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  Harness,
  SessionStore,
  resolveLlmConfig,
  type ResolvedLlmConfig,
} from '@applepi/core';
import { baseExtension, restorePermissionLevel } from '@applepi/extensions';

const extDir = new URL('../extensions/', import.meta.url).pathname;

/** Base system-prompt section contributed by the agent (Q10=c). */
function buildBaseSystemPrompt(): string {
  return [
    'You are a minimal local agent harness.',
    'You have two reference tools: `bash` and `str_replace_editor`.',
    'Use them to accomplish the user\'s request step by step.',
  ].join('\n');
}

/** Build the provider instance from resolved config (ADR-0004; no process.env). */
function buildModel(cfg: ResolvedLlmConfig): any {
  const providerSettings = { apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) };
  if (cfg.provider === 'anthropic') {
    return createAnthropic(providerSettings)(cfg.model);
  }
  return createOpenAI(providerSettings)(cfg.model);
}

/** Build a fully-wired Harness: baseExtension (reference tools + permission system) + local extensions + base contributor. */
async function boot(store: SessionStore): Promise<{ harness: Harness; loaded: string[] }> {
  const harness = new Harness();
  harness.registerExtension(baseExtension);
  harness.registerExtension((api) =>
    api.addSystemPromptContributor(() => buildBaseSystemPrompt(), 'base'),
  );
  const loaded = await harness.loadExtensionsFromDir(extDir);
  harness.attachSession(store);
  // Restore the session's permission level from the last `level/set` event
  // (ADR-0007 Q3/Q11); default `workspace` when absent.
  await restorePermissionLevel(store, harness.session.scratch);
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
  '  /config          reload LLM config from ~/.applepi (settings.json + .env)',
  '  /reload          re-scan extensions/ and rebuild the system prompt',
  '  /resume <id>     switch to and continue session <id>',
  '  /new             start a fresh session',
  '  /sessions        list sessions in this workspace',
  '  /level <readonly|workspace|fullaccess>   set the permission level (user-only)',
  '  /help            show this help',
  '  /exit            quit (or Ctrl-D)',
].join('\n');

let model = buildModel(await resolveLlmConfig());
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

    // Extension-registered slash commands take precedence over built-ins
    // (ADR-0007 Q13=a): `/level` is provided by the permission extension.
    const extHandler = harness.api.getSlashCommand(cmd);
    if (extHandler) {
      try {
        console.log(await extHandler(arg, harness.api));
      } catch (e: any) {
        console.error(`[${cmd}] error: ${e?.message}`);
      }
      rl.prompt();
      return;
    }

    switch (cmd) {
      case '/config': {
        try {
          model = buildModel(await resolveLlmConfig());
          console.log('[config] LLM config reloaded from ~/.applepi');
        } catch (e: any) {
          // Keep the current model on failure (Q10=a): a bad edit must not
          // kill a running session.
          console.error(`[config] reload failed, keeping current model: ${e?.message}`);
        }
        break;
      }
      case '/reload': {
        const oldScratch = harness.session.scratch;
        const oldHistory = harness.session.history;
        await store.appendEvent('reload/start', { extensionsDiscovered: loaded });
        ({ harness, loaded } = await boot(store));
        harness.session.scratch = oldScratch;
        harness.session.history = oldHistory;
        await harness.emitSystemPrompt();
        await store.appendEvent('reload/end', { extensionsDiscovered: loaded });
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
        // The store switched to the resumed session: re-read its last
        // `level/set` event (ADR-0007 Q3/Q11).
        await restorePermissionLevel(store, harness.session.scratch);
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
