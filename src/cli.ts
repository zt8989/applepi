import readline from 'node:readline';
import process from 'node:process';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentState } from './state';
import { getTool, getTools } from './tools';
import { abortRun } from './run-control';
import {
  createFauxRuntime,
  createRuntime,
  demoResponses,
  providerNames,
  type AgentRuntime,
} from './provider';
import { createAgentStore, waitForIdle, type AgentStore } from './store';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint('2', t);
const red = (t: string) => paint('31', t);
const green = (t: string) => paint('32', t);
const yellow = (t: string) => paint('33', t);
const cyan = (t: string) => paint('36', t);
const bold = (t: string) => paint('1', t);

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个跑在终端里的编码助手。',
  '需要实时信息、算术或文件内容时，用提供的工具去查，不要凭空猜。',
  '回答保持简短、直给；用用户的语言回答。',
].join('\n');

interface CliArgs {
  provider: string;
  model?: string;
  system: string;
  maxTurns: number;
  prompt?: string;
  apiKey?: string;
  help: boolean;
  demo: boolean;
}

const USAGE = `${bold('redux-agent')} —— Redux Loop 驱动的 Agent Loop

用法:
  redux-agent                      交互式 REPL
  redux-agent -p "问题"            跑一条就退出（脚本/管道友好）

选项:
  -p, --print <text>     一次性提问
  -P, --provider <id>    LLM provider（默认 deepseek；可用: ${providerNames().join(', ')}）
  -m, --model <id>       模型 id（默认取该 provider 的第一个模型）
  -s, --system <text>    覆盖 system prompt
      --max-turns <n>    单回合最多几轮 LLM 调用（默认 25）
      --api-key <key>    直接给 key（否则读 DEEPSEEK_API_KEY）
      --demo             不打网络：用 pi-ai 自带的 faux provider 跑一遍完整环（自检/演示）
  -h, --help             显示本帮助

REPL 命令:
  /exit /reset /tools /state /history /help
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    provider: 'deepseek',
    system: DEFAULT_SYSTEM_PROMPT,
    maxTurns: 25,
    help: false,
    demo: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${arg} 缺一个值`);
      return value;
    };
    switch (arg) {
      case '-p':
      case '--print':
        args.prompt = next();
        break;
      case '-P':
      case '--provider':
        args.provider = next();
        break;
      case '-m':
      case '--model':
        args.model = next();
        break;
      case '-s':
      case '--system':
        args.system = next();
        break;
      case '--max-turns':
        args.maxTurns = Number.parseInt(next(), 10);
        break;
      case '--api-key':
        args.apiKey = next();
        break;
      case '--demo':
        args.demo = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`);
        // 位置参数当成一次性提问
        args.prompt = args.prompt ? `${args.prompt} ${arg}` : arg;
    }
  }
  return args;
}

/** 把增量渲染出来：订阅 store，对比前后状态决定写什么。 */
class Renderer {
  private thinkingStarted = false;
  private textStarted = false;

  reset(): void {
    this.thinkingStarted = false;
    this.textStarted = false;
  }

  render(prev: AgentState, next: AgentState): void {
    // 新回合开始
    if (prev.phase === 'idle' && next.phase === 'thinking') this.reset();
    // 进入新一轮 LLM（idle→thinking 或 calling-tools→thinking）= 新的输出段
    if (prev.phase !== 'thinking' && next.phase === 'thinking') this.reset();

    if (next.thinkingText.length > prev.thinkingText.length) {
      if (!this.thinkingStarted) {
        process.stdout.write(`\n${dim('· 思考 ')}`);
        this.thinkingStarted = true;
      }
      process.stdout.write(dim(next.thinkingText.slice(prev.thinkingText.length)));
    }

    if (next.streamingText.length > prev.streamingText.length) {
      if (!this.textStarted) {
        if (this.thinkingStarted) process.stdout.write('\n');
        this.textStarted = true;
      }
      process.stdout.write(next.streamingText.slice(prev.streamingText.length));
    }

    // 新开始的工具调用
    const prevIds = new Set(prev.executing.map((t) => t.call.id));
    for (const tool of next.executing) {
      if (prevIds.has(tool.call.id)) continue;
      if (this.textStarted || this.thinkingStarted) process.stdout.write('\n');
      const toolDef = getTool(tool.call.name);
      const label = toolDef ? toolDef.label : tool.call.name;
      const argsText = JSON.stringify(tool.call.arguments ?? {});
      process.stdout.write(`  ${yellow('⚙')} ${cyan(label)} ${dim(argsText)}\n`);
      this.reset();
    }

    // 新并入的 toolResult
    for (const message of next.messages.slice(prev.messages.length)) {
      if (message.role !== 'toolResult') continue;
      const text = message.content
        .map((c) => (c.type === 'text' ? c.text : '[image]'))
        .join(' ')
        .replace(/\s+/g, ' ');
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      const mark = message.isError ? red('✗') : green('✓');
      process.stdout.write(`  ${mark} ${dim(preview)}\n`);
    }

    // 回合结束
    if (prev.phase !== 'idle' && next.phase === 'idle') {
      if (this.textStarted || this.thinkingStarted) process.stdout.write('\n');
      if (next.error) {
        process.stdout.write(`  ${red('✗')} ${red(next.error)}\n`);
      } else if (next.aborted) {
        process.stdout.write(`  ${yellow('已中断')}\n`);
      } else {
        const usage = next.usage;
        if (usage) {
          const cost = usage.cost?.total ?? 0;
          process.stdout.write(
            `  ${dim(`tokens ${usage.input}→${usage.output} · $${cost.toFixed(6)} · ${next.turns} 轮`)}\n`,
          );
        }
      }
      this.reset();
    }
  }
}

function banner(runtime: AgentRuntime, store: AgentStore): void {
  const state = store.getState();
  process.stdout.write(
    `${bold('redux-agent')} ${dim('· Redux Loop 驱动的 Agent Loop')}\n` +
      `${dim('provider')} ${state.providerName}  ${dim('model')} ${state.modelId}  ${dim('tools')} ${state.toolNames.join(', ')}\n` +
      `${dim('输入问题回车；/help 看命令，Ctrl-C 中断，/exit 退出。')}\n\n`,
  );
}

function printMessage(message: Message): void {
  if (message.role === 'user') {
    process.stdout.write(`${cyan('你 ›')} ${String(message.content)}\n`);
  } else if (message.role === 'assistant') {
    const text = message.content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `[调用 ${c.name}]` : ''))
      .join(' ')
      .trim();
    process.stdout.write(`${bold('助手 ›')} ${text}\n`);
  } else {
    const text = message.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join(' ');
    process.stdout.write(`${dim(`工具(${message.toolName}) ›`)} ${text}\n`);
  }
}

async function repl(store: AgentStore, runtime: AgentRuntime): Promise<void> {
  banner(runtime, store);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${cyan('你 ›')} `,
  });

  rl.on('SIGINT', () => {
    if (store.getState().phase !== 'idle') {
      abortRun();
      process.stdout.write('\n');
    } else {
      rl.close();
    }
  });

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    if (input.startsWith('/')) {
      const [command] = input.split(/\s+/);
      if (command === '/exit' || command === '/quit') {
        rl.close();
        return;
      }
      switch (command) {
        case '/reset':
          store.dispatch({ type: 'reset' });
          process.stdout.write(`${dim('对话已清空。')}\n`);
          break;
        case '/tools':
          for (const tool of getTools()) {
            process.stdout.write(`  ${cyan(tool.name)} ${dim(`(${tool.label})`)} ${tool.description}\n`);
          }
          break;
        case '/state':
          process.stdout.write(`${JSON.stringify(store.getState(), null, 2)}\n`);
          break;
        case '/history':
          for (const message of store.getState().messages) printMessage(message);
          break;
        case '/help':
        default:
          process.stdout.write(USAGE);
      }
      rl.prompt();
      continue;
    }

    if (store.getState().phase !== 'idle') {
      process.stdout.write(`${yellow('上一回合还没结束（Ctrl-C 可中断）。')}\n`);
      rl.prompt();
      continue;
    }

    store.dispatch({ type: 'prompt', text: input });
    try {
      await waitForIdle(store);
    } catch (error) {
      process.stdout.write(`${red(String(error instanceof Error ? error.message : error))}\n`);
    }
    rl.prompt();
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${red(String(error instanceof Error ? error.message : error))}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.apiKey) {
    process.env[`${args.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`] = args.apiKey;
  }

  let runtime: AgentRuntime;
  try {
    if (args.demo) {
      const faux = createFauxRuntime();
      faux.setResponses(demoResponses());
      runtime = faux.runtime;
    } else {
      runtime = createRuntime({ provider: args.provider, ...(args.model ? { model: args.model } : {}) });
    }
  } catch (error) {
    process.stderr.write(
      `${red(String(error instanceof Error ? error.message : error))}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const store = createAgentStore({
    runtime,
    systemPrompt: args.system,
    maxTurns: args.maxTurns,
  });

  const renderer = new Renderer();
  let previous = store.getState();
  store.subscribe(() => {
    const next = store.getState();
    renderer.render(previous, next);
    previous = next;
  });

  // --demo 不带问题：给一句默认的，跑完就退。
  const prompt = args.prompt ?? (args.demo ? '算一下 (3+4)*6' : undefined);
  if (prompt !== undefined) {
    store.dispatch({ type: 'prompt', text: prompt });
    const state = await waitForIdle(store);
    process.exitCode = state.error ? 1 : 0;
    return;
  }

  await repl(store, runtime);
}

void main();
