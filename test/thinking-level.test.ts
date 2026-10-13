/**
 * 思考级别（reasoning effort）的解析、clamp、落盘与会话往返 —— 规则逐条对齐 pi。
 *
 * ## 这条链上有四段，各有一个「只在配过 settings / 恢复过会话时才出现」的坑
 *
 * 1. **解析**（`resolveStartupThinkingLevel`）：五条来源的优先级。pi 在
 *    「会话存在但没有 `thinking_level_change`」时会**跳过** per-model 覆盖（`core/sdk.js:122-127`），
 *    这里也照抄 —— 不照抄的症状是「同一个会话在 pi 与本项目里恢复出来的档位不一样」。
 * 2. **clamp**（`clampForModel`）：默认 `medium` 在只认 `low`/`high`/`max` 的模型上会变成
 *    `high`。用户看到的「pi 默认就是 high」就是这一段（不是 pi 把默认写成了 high）。
 * 3. **换模型**（`thinkingLevelForModelSwitch`）：pi 会重新解析（per-model / 全局默认优先于
 *    「当前这一档」），没配过时才等价于「级别带着走」。
 * 4. **会话往返**：新会话写一条初始档位、改档位写一条、老会话缺那条就回填一条 ——
 *    缺了这一条，恢复时又得靠默认值猜。
 *
 * 全部测试把 `PI_CODING_AGENT_DIR` 指到临时目录（`test/isolated-home.ts` 已经做了一层，
 * 这里每例再建一个自己的，因为要往里面写 `models.json` / `settings.json`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { createSessionRecorder } from '../src/session-recorder';
import { SessionWriter, readSessionThinking, readSessionMessages } from '../src/session-file';
import { findSessionFile } from '../src/config-home';
import { createKernel } from '../src/kernel';
import {
  DEFAULT_THINKING_LEVEL,
  clampForModel,
  isThinkingLevel,
  readDefaultThinkingLevel,
  readModelThinkingLevel,
  resolveStartupThinkingLevel,
  thinkingLevelForModelSwitch,
  writeDefaultThinkingLevel,
  writeModelThinkingLevel,
} from '../src/thinking-level';
import type { AgentAction } from '../src/actions';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';

/** 在一个隔离的配置家目录里跑 fn（可选先写 models.json / settings.json）。 */
async function withAgentHome(
  files: { models?: unknown; settings?: unknown },
  fn: (home: string) => Promise<void> | void,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'ela-thinking-home-'));
  const previous = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = home;
  try {
    if (files.models !== undefined) {
      await writeFile(path.join(home, 'models.json'), `${JSON.stringify(files.models, null, 2)}\n`, 'utf8');
    }
    if (files.settings !== undefined) {
      await writeFile(path.join(home, 'settings.json'), `${JSON.stringify(files.settings, null, 2)}\n`, 'utf8');
    }
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * `qwen-token-plan-cn/deepseek-v4.1-flash` 在 pi 的模型目录里那张表（逐字抄的）。
 *
 * 它是这一串测试的现实依据：`off` / `minimal` / `medium` / `xhigh` 都是 `null`（不支持），
 * 于是支持集 = `low` / `high` / `max` —— **默认 medium 会被抬到 high**，这正是用户看到的
 * 「pi 的 deepseek-v4.1-flash 默认思考就是 high」。
 */
const DEEPSEEK_MAP = {
  off: null,
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max',
} as const;

function model(options: { thinkingLevelMap?: unknown; reasoning?: boolean } = {}): Model<any> {
  return {
    provider: 'p',
    id: 'm',
    reasoning: options.reasoning ?? true,
    ...(options.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: options.thinkingLevelMap }),
  } as unknown as Model<any>;
}

// ─── clamp：默认 medium 为什么变成 high ───

test('clampForModel：medium 在只认 low/high/max 的模型上抬到 high', () => {
  const m = model({ thinkingLevelMap: DEEPSEEK_MAP });
  assert.equal(clampForModel(m, 'medium'), 'high', '向上找第一个支持的档位');
  assert.equal(clampForModel(m, 'off'), 'low', 'off 也不支持 —— 这个模型关不掉思考');
  assert.equal(clampForModel(m, 'minimal'), 'low');
  assert.equal(clampForModel(m, 'xhigh'), 'max', 'xhigh 不支持，向上是 max');
  assert.equal(clampForModel(m, 'low'), 'low', '支持的档位原样');
  assert.equal(clampForModel(m, 'max'), 'max');
});

test('clampForModel：没给模型 / 非 reasoning 模型都是 off', () => {
  assert.equal(clampForModel(undefined, 'medium'), 'off');
  assert.equal(clampForModel(model({ reasoning: false }), 'high'), 'off');
});

test('clampForModel：没有 thinkingLevelMap 的模型原样放行（pi-ai 的判据是「没写这个键 = 支持」）', () => {
  const m = model();
  for (const level of ['off', 'minimal', 'low', 'medium', 'high'] as const) {
    assert.equal(clampForModel(m, level), level);
  }
});

// ─── 解析：五条来源的优先级 ───

test('resolveStartupThinkingLevel：命令行 > 会话 > per-model > 全局默认 > 内置 medium', () => {
  // 命令行最高优先。
  assert.equal(
    resolveStartupThinkingLevel({
      cliLevel: 'xhigh',
      sessionLevel: 'low',
      perModelLevel: 'minimal',
      defaultLevel: 'high',
    }),
    'xhigh',
  );
  // 没有命令行 → 会话里那条。
  assert.equal(
    resolveStartupThinkingLevel({
      sessionLevel: 'low',
      perModelLevel: 'minimal',
      defaultLevel: 'high',
    }),
    'low',
  );
  // 没有会话（undefined）→ per-model。
  assert.equal(
    resolveStartupThinkingLevel({ perModelLevel: 'minimal', defaultLevel: 'high' }),
    'minimal',
  );
  // 只有全局默认。
  assert.equal(resolveStartupThinkingLevel({ defaultLevel: 'high' }), 'high');
  // 什么都没有 → pi 的内置 medium。
  assert.equal(resolveStartupThinkingLevel({}), DEFAULT_THINKING_LEVEL);
  assert.equal(DEFAULT_THINKING_LEVEL, 'medium');
});

test('resolveStartupThinkingLevel：会话在但没有那条记录时**跳过** per-model（pi 的怪处，照抄）', () => {
  // `sessionLevel` 给了但值是 `undefined` 之外的东西都不是合法档位 —— 而「会话在」这件事
  // 本身就会短路。pi 的 `sdk.js:122-127` 是这个形状：
  //   hasThinkingEntry ? existingSession.thinkingLevel : (default ?? DEFAULT)
  // 于是老会话（没写过 thinking 条目）+ 配了 per-model 覆盖时，用的是**全局默认**。
  // 改了它，症状是「同一个会话在 pi 与本项目里恢复出来的档位不一样」。
  assert.equal(
    resolveStartupThinkingLevel({ sessionLevel: '', perModelLevel: 'minimal', defaultLevel: 'high' }),
    'high',
  );
  // 会话里那条被手改坏了（非法值）也走同一条路。
  assert.equal(
    resolveStartupThinkingLevel({ sessionLevel: 'ultra', perModelLevel: 'minimal', defaultLevel: 'high' }),
    'high',
  );
});

test('resolveStartupThinkingLevel：非法值当「没给」，不抛（手改坏 settings 不该让启动炸掉）', () => {
  assert.equal(resolveStartupThinkingLevel({ cliLevel: 'High' }), DEFAULT_THINKING_LEVEL, '大小写敏感');
  assert.equal(resolveStartupThinkingLevel({ cliLevel: 'huge' }), DEFAULT_THINKING_LEVEL);
  assert.equal(resolveStartupThinkingLevel({ perModelLevel: 42 as unknown as string }), DEFAULT_THINKING_LEVEL);
  assert.equal(isThinkingLevel('off'), true);
  assert.equal(isThinkingLevel('max'), true);
  assert.equal(isThinkingLevel('medium '), false);
});

// ─── 换模型 ───

test('thinkingLevelForModelSwitch：作用域条目 > per-model > 全局默认 > 当前这一档', () => {
  const m = model({ thinkingLevelMap: DEEPSEEK_MAP });
  const base = { current: 'low' as const, defaultLevel: 'max', perModelLevel: 'low' };
  assert.equal(
    thinkingLevelForModelSwitch(m, { ...base, scopedLevel: 'high' }),
    'high',
    '作用域条目写死了就用它',
  );
  assert.equal(thinkingLevelForModelSwitch(m, base), 'low', 'per-model 压过全局默认');
  assert.equal(
    thinkingLevelForModelSwitch(m, { current: 'low', defaultLevel: 'max' }),
    'max',
    '没有 per-model → 全局默认',
  );
  assert.equal(
    thinkingLevelForModelSwitch(m, { current: 'low' }),
    'low',
    '都没配 → 当前这一档（级别带着走）',
  );
  assert.equal(
    thinkingLevelForModelSwitch(m, { current: 'bogus' as never }),
    'high',
    '当前值不是合法档位（不该发生）→ 下面是内置 medium，再 clamp 成 high',
  );
  assert.equal(
    thinkingLevelForModelSwitch(m, { current: 'off' }),
    'low',
    '当前值合法但与模型不匹配（off）→ clamp 成 low',
  );
});

test('thinkingLevelForModelSwitch：换到能力不同的模型要 clamp', () => {
  // 从「全档位都支持」的模型换到只认 low/high/max 的：medium 必须被抬走，
  // 否则会发出模型不认的 reasoning 值。
  assert.equal(
    thinkingLevelForModelSwitch(model({ thinkingLevelMap: DEEPSEEK_MAP }), { current: 'medium' }),
    'high',
  );
  // 反向：从只认 high 的模型换到全支持 —— 原样。
  assert.equal(thinkingLevelForModelSwitch(model(), { current: 'high' }), 'high');
});

// ─── settings 落盘（与 pi 同一个键、同一个文件） ───

test('writeDefaultThinkingLevel：写的是 pi 的 `defaultThinkingLevel`，读得回来', async () => {
  await withAgentHome({}, async (home) => {
    assert.equal(readDefaultThinkingLevel(home), undefined, '没配过就是 undefined');
    assert.equal(await writeDefaultThinkingLevel('high', home), true);
    assert.equal(readDefaultThinkingLevel(home), 'high');
    // 盘上真的是 pi 那个键 —— 写成别的名字 pi 不认，而「本项目存了、pi 说没存」这种分歧
    // 只在重启后才看得出来。
    const onDisk = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')) as {
      defaultThinkingLevel?: string;
    };
    assert.equal(onDisk.defaultThinkingLevel, 'high');
  });
});

test('writeModelThinkingLevel：键是 `provider/id`（pi 的 `modelThinkingLevels`）', async () => {
  await withAgentHome({}, async (home) => {
    assert.equal(readModelThinkingLevel('p', 'm', home), undefined);
    assert.equal(await writeModelThinkingLevel('p', 'm', 'low', home), true);
    assert.equal(readModelThinkingLevel('p', 'm', home), 'low');
    const onDisk = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')) as {
      modelThinkingLevels?: Record<string, string>;
    };
    assert.deepEqual(onDisk.modelThinkingLevels, { 'p/m': 'low' });
  });
});

// ─── 会话文件：记录什么、读回来什么 ───

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userMessage = (text: string): Message =>
  ({ role: 'user', content: text, timestamp: 1 }) as Message;

const assistantMessage = (text: string): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage,
    stopReason: 'stop',
    timestamp: 1,
  }) as unknown as AssistantMessage;

/** 一个最小的 store（与 session.test.ts 里那个同一形状 —— 记录器只用到这三件事）。 */
function recorderStore(thinkingLevel: 'off' | 'low' | 'high' | 'max' = 'low'): {
  store: { getState: () => AgentState; subscribe: (l: () => void) => () => void };
  dispatch: (a: AgentAction) => void;
} {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 's1',
    thinkingLevel,
  });
  let notify: (() => void) | null = null;
  const dispatch = (a: AgentAction): void => {
    state = reducer(state, a) as AgentState;
    notify?.();
  };
  return {
    store: {
      getState: () => state,
      subscribe: (l: () => void) => {
        notify = l;
        return () => {
          notify = null;
        };
      },
    },
    dispatch,
  };
}

test('记录器：写第一条消息时补一条 thinking_level_change（pi 在会话建立时也写这一条）', async () => {
  await withAgentHome({}, async () => {
    const { store, dispatch } = recorderStore('low');
    const rec = createSessionRecorder(store, { sessionId: 's1', cwd: '/proj', enabled: true });
    assert.ok(rec);
    dispatch({ type: 'user.message', text: '一问' });
    rec.dispose();

    const info = readSessionThinking(rec.file);
    assert.ok(info);
    assert.equal(info.hasMessages, true);
    assert.equal(info.hasEntry, true, '没有这一条，下次恢复就不知道该用哪一档');
    assert.equal(info.level, 'low');
  });
});

test('记录器：纯空会话不因为这一条而建文件（本项目的「空会话不落盘」）', async () => {
  await withAgentHome({}, async () => {
    const { store } = recorderStore('high');
    const rec = createSessionRecorder(store, { sessionId: 'empty1', cwd: '/proj', enabled: true });
    assert.ok(rec);
    rec.dispose();
    assert.equal(readSessionThinking(rec.file), undefined, '一句话都没说 → 盘上不该有这个文件');
  });
});

test('记录器：改档位写一条，没改不写（订阅器每帧都跑）', async () => {
  await withAgentHome({}, async () => {
    const { store, dispatch } = recorderStore('low');
    const rec = createSessionRecorder(store, { sessionId: 's2', cwd: '/proj', enabled: true });
    assert.ok(rec);
    dispatch({ type: 'user.message', text: '一问' });
    // 每帧都跑：没有变化时不该追加任何东西。
    dispatch({ type: 'llm.delta', delta: 'x' });
    dispatch({ type: 'llm.delta', delta: 'y' });
    dispatch({ type: 'thinking.changed', level: 'high' });
    dispatch({ type: 'llm.delta', delta: 'z' });
    rec.dispose();

    const text = await readFile(rec.file, 'utf8');
    const changes = text
      .split('\n')
      .filter((line) => line.includes('"thinking_level_change"'))
      .map((line) => JSON.parse(line) as { thinkingLevel: string });
    assert.deepEqual(changes.map((c) => c.thinkingLevel), ['low', 'high'], '初始一条 + 变化一条，就两条');
    assert.equal(readSessionThinking(rec.file)?.level, 'high', '最后一条生效');
  });
});

test('记录器：恢复的老会话缺这一条时回填一条（推迟到真的要写文件的那一刻）', async () => {
  await withAgentHome({}, async () => {
    // 老会话：只有消息，没有 thinking 条目。
    const w = new SessionWriter('old1', '/proj');
    w.start();
    w.appendMessage(userMessage('旧的'));

    const { store, dispatch } = recorderStore('high');
    // 与内核同一条路：**先把历史灌回状态**，再开记录器（`resumeFrom` 告诉它
    // 「那 1 条已经在文件里了」）—— 只给 resumeFrom 而状态是空的，记录器会以为
    // 「还有 1 条没写」，那是另一件事（写完就该有 2 条，而状态里只有 1 条）。
    dispatch({ type: 'conversation.restored', sessionId: 'old1', messages: [userMessage('旧的')] });
    const rec = createSessionRecorder(store, {
      sessionId: 'old1',
      cwd: '/proj',
      enabled: true,
      resumeFrom: 1,
      hasThinkingEntry: false,
    });
    assert.ok(rec);
    // 刚恢复时**不动盘**（与 pi 有一处时间差，见 `hasThinkingEntry` 的注释）——
    // 那条硬挣来的不变式是「恢复不写盘」。
    assert.equal(readSessionThinking(rec.file)?.hasEntry, false, '恢复本身不写盘');

    // 真的要说下一句话时才回填（顺序：先补这一档，再写消息）。
    dispatch({ type: 'user.message', text: '接着聊' });
    rec.dispose();

    const info = readSessionThinking(rec.file);
    assert.equal(info?.hasEntry, true, '回填了一条');
    assert.equal(info?.level, 'high');
    assert.deepEqual(
      readSessionMessages(rec.file).map((m) => m.role),
      ['user', 'user'],
      '旧消息没被重写，新消息是追加的',
    );
  });
});

// ─── 内核：端到端（启动档位怎么来的、恢复会话带不带回来） ───

/** 一个只认 low/high/max 的自定义 provider（借 models.json 装出来，与用户的网关同形状）。 */
const REASONING_MODELS = {
  providers: {
    testprov: {
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: 'test',
      models: [
        {
          id: 'm1',
          api: 'openai-completions',
          reasoning: true,
          thinkingLevelMap: DEEPSEEK_MAP,
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
    },
  },
};

async function withKernel(
  settings: unknown,
  fn: (kernel: Awaited<ReturnType<typeof createKernel>>, home: string) => Promise<void> | void,
  options: { sessionId?: string; thinkingLevel?: 'off' | 'low' | 'high' | 'medium' | 'max' } = {},
): Promise<void> {
  await withAgentHome({ models: REASONING_MODELS, settings }, async (home) => {
    const kernel = await createKernel({
      provider: 'testprov',
      model: 'm1',
      cwd: home,
      noExtensions: true,
      writeSession: false,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    });
    try {
      await fn(kernel, home);
    } finally {
      kernel.dispose();
    }
  });
}

test('内核：settings 的 medium 在只认 low/high/max 的模型上启动为 high（用户看到的那件事）', async () => {
  await withKernel({ defaultThinkingLevel: 'medium' }, (kernel) => {
    assert.equal(kernel.store.getState().thinkingLevel, 'high');
  });
});

test('内核：什么都没配时用 pi 的内置 medium，再 clamp 成 high', async () => {
  await withKernel(undefined, (kernel) => {
    assert.equal(kernel.store.getState().thinkingLevel, 'high');
  });
});

test('内核：per-model 覆盖压过全局默认', async () => {
  await withKernel(
    { defaultThinkingLevel: 'medium', modelThinkingLevels: { 'testprov/m1': 'low' } },
    (kernel) => {
      assert.equal(kernel.store.getState().thinkingLevel, 'low');
    },
  );
});

test('内核：--thinking off 也被 clamp（这个模型关不掉思考，与 pi 同一行为）', async () => {
  await withKernel(undefined, (kernel) => {
    assert.equal(kernel.store.getState().thinkingLevel, 'low');
  }, { thinkingLevel: 'off' });
});

test('内核：--thinking 最高优先，且仍然 clamp', async () => {
  await withKernel(
    { defaultThinkingLevel: 'low', modelThinkingLevels: { 'testprov/m1': 'low' } },
    (kernel) => {
      assert.equal(kernel.store.getState().thinkingLevel, 'high');
    },
    { thinkingLevel: 'medium' },
  );
});

test('内核：--session 启动时用会话文件里那条档位', async () => {
  await withAgentHome({ models: REASONING_MODELS, settings: { defaultThinkingLevel: 'low' } }, async (home) => {
    const w = new SessionWriter('saved1', home);
    w.start();
    w.appendThinkingChange('max');
    w.appendMessage(userMessage('续聊'));

    const kernel = await createKernel({
      provider: 'testprov',
      model: 'm1',
      cwd: home,
      sessionId: 'saved1',
      noExtensions: true,
      writeSession: false,
    });
    try {
      // 全局默认是 low，而会话里说的是 max —— 会话赢（pi 的 sdk.js:122-127）。
      assert.equal(kernel.store.getState().thinkingLevel, 'max');
    } finally {
      kernel.dispose();
    }
  });
});

test('内核 restoreSession：把会话里的档位带回来（并 clamp）', async () => {
  await withAgentHome({ models: REASONING_MODELS }, async (home) => {
    const w = new SessionWriter('res1', home);
    w.start();
    w.appendThinkingChange('high');
    w.appendMessage(userMessage('一句'));
    w.appendMessage(assistantMessage('一答'));

    const kernel = await createKernel({
      provider: 'testprov',
      model: 'm1',
      cwd: home,
      noExtensions: true,
      writeSession: false,
    });
    try {
      assert.equal(kernel.store.getState().thinkingLevel, 'high', '启动时是默认解析的结果');
      const file = findSessionFile('res1', home);
      await kernel.restoreSession(file);
      assert.equal(kernel.store.getState().thinkingLevel, 'high', '恢复后跟会话里那条走');
      assert.equal(kernel.store.getState().messages.length, 2, '消息也灌回来了');
    } finally {
      kernel.dispose();
    }
  });
});

test('内核 restoreSession：老会话（没有那条记录）保持启动解析出来的档位，且**不写盘**', async () => {
  await withAgentHome({ models: REASONING_MODELS }, async (home) => {
    // 老会话：只有消息，没有 thinking 条目（早于这个功能的会话就是这个形状）。
    const w = new SessionWriter('res2', home);
    w.start();
    w.appendMessage(userMessage('一句'));
    const file = findSessionFile('res2', home);
    const before = await readFile(file);

    const kernel = await createKernel({
      provider: 'testprov',
      model: 'm1',
      cwd: home,
      noExtensions: true, // 记录器要真的写盘（这里不传 writeSession: false）
    });
    try {
      await kernel.restoreSession(file);
      // 没有那条记录 → 不动（保持启动解析出来的 high），但仍然要 clamp 过。
      assert.equal(kernel.store.getState().thinkingLevel, 'high');
      // 恢复本身不写盘（那条不变式在 `test/restore-perf.test.ts` 里守得很紧）；
      // 回填推迟到下一次真的要写文件时（见 `hasThinkingEntry` 的注释）。
      assert.deepEqual(await readFile(file), before, '恢复不该改会话文件');
    } finally {
      kernel.dispose();
    }
  });
});