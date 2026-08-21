import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  Harness,
  SessionStore,
  resolveLlmConfig,
  type ResolvedLlmConfig,
} from '@applepi/core';
import {
  makeBundleSpec,
  bundleEnv,
  enableBundleSpec,
  assembleFlatPrompt,
} from '@applepi/bundle';
import { loadPlugins, type PluginSpec } from './plugins.js';

// fileURLToPath (not .pathname): .pathname yields a `/C:/...` root-relative
// path on Windows, which fs.readdir cannot resolve (plugins would be missed).
const extDir = fileURLToPath(new URL('../extensions/', import.meta.url));

// ---- mode selection (ADR-0015) ----------------------------------------------
// Chosen once at start (`--mode base|standard`, default standard = the full
// capability set, so today's base+memory+skills behavior is preserved). Not a
// hot-swap: mode is immutable for the session.
const MODES = ['base', 'standard'] as const;
type Mode = (typeof MODES)[number];

function resolveMode(argv: string[]): Mode {
  const i = argv.indexOf('--mode');
  if (i >= 0 && argv[i + 1]) {
    const m = argv[i + 1];
    if ((MODES as readonly string[]).includes(m)) return m as Mode;
    console.error(`unknown mode: ${m} (use ${MODES.join('|')})`);
    process.exit(1);
  }
  return 'standard';
}

const MODE = resolveMode(process.argv.slice(2));

/** Build the provider instance from resolved config (ADR-0004; no process.env). */
function buildModel(cfg: ResolvedLlmConfig): any {
  const providerSettings = { apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) };
  if (cfg.provider === 'anthropic') {
    return createAnthropic(providerSettings)(cfg.model);
  }
  return createOpenAI(providerSettings)(cfg.model);
}

/** App-interface fragments (CLI): working environment guidance (ADR-0015 app layer). */
function appInterface(): string[] {
  return [
    'You are running in the applepi CLI. Use the project root below for file operations.',
    `Project root: ${process.cwd()}`,
  ];
}

interface Booted {
  harness: Harness;
  plugins: PluginSpec[];
  pluginToolNames: string[];
}

async function loadPluginsInto(
  harness: Harness,
): Promise<{ plugins: PluginSpec[]; pluginToolNames: string[] }> {
  const plugins = await loadPlugins(extDir);
  const pluginToolNames: string[] = [];
  for (const p of plugins) {
    for (const t of p.tools ?? []) {
      harness.registerTool(t);
      pluginToolNames.push(t.name);
    }
  }
  return { plugins, pluginToolNames };
}

/**
 * Boot a fully-wired Harness (ADR-0015): enable the chosen bundle (its tools +
 * capability tools), load app-layer plugins, attach the session, and restore
 * the permission level.
 */
async function boot(store: SessionStore): Promise<Booted> {
  const harness = new Harness();
  // Tools are independent of the permission level — register from a default env.
  const spec = makeBundleSpec(MODE, { cwd: process.cwd() })!;
  enableBundleSpec(harness, spec);
  const { plugins, pluginToolNames } = await loadPluginsInto(harness);
  harness.attachSession(store);
  // Restore the session's permission level from the last `level/set` event via
  // the core SecurityPolicy (ADR-0009); default `workspace` when absent.
  await harness.restoreSecurity(store);
  return { harness, plugins, pluginToolNames };
}

/**
 * Assemble the flat system prompt for THIS turn. The spec is re-read with the
 * LIVE env (permission level, workspace) each turn — no rebuild events; the
 * bundle's level-aware declaration + capability fragments are re-rendered.
 */
function buildPrompt(harness: Harness, plugins: PluginSpec[]): string {
  const env = bundleEnv(harness);
  const spec = makeBundleSpec(MODE, env)!;
  return assembleFlatPrompt(harness, spec, {
    app: appInterface(),
    plugins: plugins.flatMap((p) => p.prompt ?? []),
  });
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
        else if (part.type === 'reasoning') console.log(`[thinking] ${part.text}`);
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
  '  /reload          re-scan extensions/ (plugins) and rebuild the system prompt',
  '  /resume <id>     switch to and continue session <id>',
  '  /new             start a fresh session',
  '  /sessions        list sessions in this workspace',
  '  /level <readonly|workspace|fullaccess>   set the permission level (user-only)',
  '  /help            show this help',
  '  /exit            quit (or Ctrl-D)',
  '',
  `Mode: ${MODE} (chosen at start; base|standard — not hot-swappable)`,
].join('\n');

let model = buildModel(await resolveLlmConfig());
let store = new SessionStore();
await store.create();
console.log(`[session] ${store.sessionId} (workspace: ${store.workspace}) [mode: ${MODE}]`);

let { harness, plugins, pluginToolNames } = await boot(store);
if (plugins.length) {
  console.error(`[harness] loaded plugins: ${plugins.map((p) => p.name ?? '(unnamed)').join(', ')}`);
}

// Fresh session: persist the initial system prompt once (app layer, ADR-0015).
await store.appendMessage('system', buildPrompt(harness, plugins));
console.log('[system] system prompt persisted');

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
const initial = process.argv[2];

async function handleTurn(input: string): Promise<void> {
  const messages = await harness.run(input, buildPrompt(harness, plugins), model);
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

    // Harness-registered slash commands (core `/level`, app-registered) take
    // precedence over built-ins (ADR-0007 Q13=a).
    const handler = harness.getSlashCommand(cmd);
    if (handler) {
      try {
        console.log(await handler(arg));
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
        // Plugin reload (ADR-0015): revoke the plugin-layer tools, re-scan the
        // dir, re-register, rebuild the prompt. The bundle/mode are immutable;
        // session.scratch + history are preserved (no new Harness).
        for (const n of pluginToolNames) harness.unregisterTool(n);
        const loaded = await loadPluginsInto(harness);
        plugins = loaded.plugins;
        pluginToolNames = loaded.pluginToolNames;
        // Persist the rebuilt prompt (replay rule: with a reload event, the
        // most-recent system message replaces message[0]).
        await store.appendEvent('reload/start', { pluginsDiscovered: plugins.map((p) => p.name) });
        const rebuilt = buildPrompt(harness, plugins);
        await store.appendMessage('system', rebuilt);
        await store.appendEvent('reload/end', { pluginsDiscovered: plugins.map((p) => p.name) });
        console.log(`[reload] plugins re-scanned (${plugins.length}), system prompt rebuilt`);
        break;
      }
      case '/resume': {
        if (!arg) {
          console.log('usage: /resume <session_id>');
          break;
        }
        const b = await boot(store);
        harness = b.harness;
        plugins = b.plugins;
        pluginToolNames = b.pluginToolNames;
        store = await harness.resume(arg);
        // The store switched to the resumed session: re-read its last
        // `level/set` event (ADR-0009, core SecurityPolicy).
        await harness.restoreSecurity(store);
        console.log(`[resume] active session -> ${store.sessionId}`);
        break;
      }
      case '/new': {
        store = new SessionStore();
        await store.create();
        const b = await boot(store);
        harness = b.harness;
        plugins = b.plugins;
        pluginToolNames = b.pluginToolNames;
        await store.appendMessage('system', buildPrompt(harness, plugins));
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
