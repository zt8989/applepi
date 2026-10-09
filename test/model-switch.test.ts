/**
 * 换模型的回归测试（`/model` 与 `Ctrl+L` 那条路）。
 *
 * ## 为什么这批要钉住
 *
 * `/model` 面板本身是 pi 官方的组件（`model-picker.ts` 是适配层），它退化不了。**会退化的是
 * 「换了之后下一个回合真的发给新模型」这一段** —— 而那段的失败形态是最坏的一种：
 *
 * ```text
 *   底栏：(workbuddy) cn:deepseek-v4.1-flash     ← 换了
 *   轨迹树：model.init workbuddy/cn:deepseek…   ← 也换了（它读 state）
 *   实际请求：发给了 cn:space-bunny             ← 没换（effect 表捕获了建表那一个）
 * ```
 *
 * 三个可见证据都说换了，而请求没换。所以**必须**有一条真发请求的测试盯住它 ——
 * 只测 reducer 的 `model.changed` / `model.init` 是**不够**的（那两个都过，环照样跑旧模型）。
 *
 * 用 faux provider 造**两个**模型（`provider.ts` 的 `createFauxRuntime()` 只装一个），
 * 让它把「收到请求的是哪个模型」记下来 —— 那样断言不依赖任何文案。
 *
 * 另一条盯的是 `kernel.setModel()` 的**闸**：模型不存在时必须**不 dispatch**
 * （状态原封不动）。漏了的话底栏会显示一个没人知道能力的模型名，而请求带着清零的
 * 能力发出去 —— 那种失败长得像「随机 400」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import type { AgentRuntime } from '../src/provider';
import { createKernel, readCapabilities } from '../src/kernel';
import { scopeFrom } from '../src/tui/app';
import { readScopedModels } from '../src/model-scope';

/**
 * 一个有两个模型的 faux 装配，并把**每次请求用的模型 id** 记进 `seen`。
 *
 * ## 为什么自己造而不用 `createFauxRuntime()`
 *
 * 那个只注册一个模型，于是「换到另一个」根本无从换起 —— 而「换到另一个」正是要测的东西。
 *
 * ## `seen` 靠**每回合现挂**一条响应，不能只在建表时挂一次
 *
 * faux 的响应队列是 `shift()` 消费的（`faux.js` 的 `stream`），**一轮一条**。所以
 * 第一回合就把那一条用完了，第二回合拿到的是 `No more faux responses queued`
 * （一条 error 消息）—— 而那**不会**推进 `seen`。症状是「第二条没记上」，
 * 看着像模型没换，而真因是队列空了。`queueFor()` 就是每回合 `appendResponses` 一条。
 */
function twoModelRuntime(): {
  runtime: AgentRuntime;
  seen: string[];
  queueFor(): void;
} {
  const faux = fauxProvider({
    models: [
      { id: 'model-a', contextWindow: 1000 },
      { id: 'model-b', contextWindow: 2000 },
    ],
  });
  const seen: string[] = [];
  const models = createModels();
  models.setProvider(faux.provider);
  const queueFor = (): void => {
    faux.appendResponses([
      (_ctx, _opts, _state, model) => {
        seen.push(model.id);
        return fauxAssistantMessage('ok');
      },
    ]);
  };
  const model = faux.getModel('model-a');
  assert.ok(model, 'faux 应该装上 model-a');
  return {
    runtime: { models, spec: { provider: faux.provider.id, model: model.id }, model },
    seen,
    queueFor,
  };
}

/** 建 store 时把「思考级别 / 窗口 / 能力」按初始模型装好（等价于内核的 model.init）。 */
function seedModelInit(store: ReturnType<typeof createAgentStore>, runtime: AgentRuntime): void {
  const model = runtime.model;
  store.dispatch({
    type: 'model.init',
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: 'off',
    capabilities: readCapabilities(model),
    contextWindow: model.contextWindow ?? 0,
  });
}

test('换了模型之后，下一个回合真的发给新的那个（不是建表那一个）', async () => {
  const { runtime, seen, queueFor } = twoModelRuntime();
  const store = createAgentStore({ runtime, systemPrompt: 'test' });
  seedModelInit(store, runtime);

  // 第一轮：应当发给 model-a。
  queueFor();
  store.dispatch({ type: 'user.message', text: '第一句' });
  await waitForIdle(store);
  assert.deepEqual(seen, ['model-a'], '第一轮应发给建表时的那个模型');

  // 换模型：与 `kernel.setModel()` 发的是**同样两条** action（顺序也一样）。
  const target = runtime.models.getModel(runtime.spec.provider, 'model-b');
  assert.ok(target, '装配里应该有 model-b');
  store.dispatch({ type: 'model.changed', provider: target.provider, modelId: target.id });
  store.dispatch({
    type: 'model.init',
    provider: target.provider,
    modelId: target.id,
    thinkingLevel: 'off',
    capabilities: readCapabilities(target),
    contextWindow: target.contextWindow ?? 0,
  });

  // 第二轮：这一条就是整批测试的核心断言。
  queueFor();
  store.dispatch({ type: 'user.message', text: '第二句' });
  await waitForIdle(store);
  assert.deepEqual(seen, ['model-a', 'model-b'], '换完之后的请求必须发给 model-b');
});

test('换了模型之后，压缩用的也是新模型（压缩那条路也读 state，不是闭包）', async () => {
  // `compactContext` 与 `callLlm` 在同一个闭包里，早先两个都捕获 `model`。
  // 只修 `callLlm` 的话症状是「回答换模型了、压缩仍用旧模型」—— 而压缩是**平时看不见**的
  // 那条路：它的效果要到窗口快满时才显形，那时没人想得起来是这里。
  const { runtime, seen, queueFor } = twoModelRuntime();
  const store = createAgentStore({ runtime, systemPrompt: 'test' });
  seedModelInit(store, runtime);
  const target = runtime.models.getModel(runtime.spec.provider, 'model-b');
  assert.ok(target);
  store.dispatch({ type: 'model.changed', provider: target.provider, modelId: target.id });
  store.dispatch({
    type: 'model.init',
    provider: target.provider,
    modelId: target.id,
    thinkingLevel: 'off',
    capabilities: readCapabilities(target),
    contextWindow: target.contextWindow ?? 0,
  });
  // 灌一批**足够老**的对话，让 `findCutPoint` 找得到切点。
  //
  // 为什么不用真的跑几轮：20 轮 LLM 假流只是为了把 messages 填长，而直接用
  // `session.restored` 填是同一条路径（都是 append），且不依赖响应队列。
  // 消息要够大（每条 6000 字符 ≈ 1500 token），而 model-b 的窗口是 2000 ——
  // 切点规则是「保留最近的若干条」，老到装不下才会被切。
  for (let i = 0; i < 20; i += 1) {
    store.dispatch({
      type: 'session.restored',
      message: { role: 'user', content: `老消息${i}`.padEnd(6000, 'x'), timestamp: i },
    });
  }
  queueFor();
  store.dispatch({ type: 'compact.request', reason: 'manual' });
  // **不能用 `waitForIdle` 等压缩**：压缩期间 `phase` 本来就是 `idle`（它不是一轮对话），
  // 而 `waitForIdle` 第一行就判「已经 idle」直接返回 —— 于是 `seen` 还是空的。
  // 这与 `store.ts` 的 `createAutoCompact` 为什么盯 `phase` 而不是靠某条 action 是同一件事。
  const state = await waitForCompaction(store);
  // 压缩要打一次网络（这里就是 faux）：它该发给 model-b。
  assert.ok(seen.includes('model-b'), `压缩那条请求应发给 model-b，实际：${JSON.stringify(seen)}`);
  assert.ok(!seen.includes('model-a'), `不该再发给 model-a，实际：${JSON.stringify(seen)}`);
  // 压确实发生了。**不钉死 summarizedCount**：那取决于 `keepRecentTokens`
  // （默认 20000）能留几条，而一条 6000 字符的 user 消息 ≈ 1500 token ——
  // 于是「20 条压掉 19 留 1」与「压掉 20」都是对的，钉死它只会让这条测试
  // 在将来改了压缩参数时莫名变红，而它本来要盯的是**发给谁**。
  assert.ok(
    (state.lastCompaction?.summarizedCount ?? 0) > 0,
    '老消息应被压成一段摘要',
  );
});

test('换了模型之后，能力与窗口跟着换（不是沿用旧模型的那套）', async () => {
  const { runtime } = twoModelRuntime();
  const store = createAgentStore({ runtime, systemPrompt: 'test' });
  seedModelInit(store, runtime);
  assert.equal(store.getState().model.contextWindow, 1000, '初始窗口应是 model-a 的 1000');

  const target = runtime.models.getModel(runtime.spec.provider, 'model-b');
  assert.ok(target);
  store.dispatch({ type: 'model.changed', provider: target.provider, modelId: target.id });
  store.dispatch({
    type: 'model.init',
    provider: target.provider,
    modelId: target.id,
    thinkingLevel: 'off',
    capabilities: readCapabilities(target),
    contextWindow: target.contextWindow ?? 0,
  });

  // 底栏那个百分比是**从 state 算**的（`statsLine` 用 `state.model.contextWindow`），
  // 所以窗口没跟着换的症状是「换了模型、百分比却还是按 1000 算的」。
  assert.equal(store.getState().model.contextWindow, 2000, '窗口应变成 model-b 的 2000');
  assert.equal(store.getState().modelId, 'model-b');
  assert.equal(store.getState().providerName, target.provider);
});

test('思考级别跨换模型保留（换模型不该顺手把 high 改成 off）', () => {
  const { runtime } = twoModelRuntime();
  const store = createAgentStore({ runtime, systemPrompt: 'test' });
  store.dispatch({ type: 'thinking.changed', level: 'high' });
  const target = runtime.models.getModel(runtime.spec.provider, 'model-b');
  assert.ok(target);
  // `kernel.setModel()` 正是这样从 state 读回级别的（见 kernel.ts 那个 setModel）。
  const thinkingLevel = store.getState().model.thinkingLevel;
  store.dispatch({ type: 'model.changed', provider: target.provider, modelId: target.id });
  store.dispatch({
    type: 'model.init',
    provider: target.provider,
    modelId: target.id,
    thinkingLevel,
    capabilities: readCapabilities(target),
    contextWindow: target.contextWindow ?? 0,
  });
  assert.equal(store.getState().model.thinkingLevel, 'high');
});

/** 等一次手动压缩跑完（结果落在 `lastCompaction` 或 `error` 上）。 */
async function waitForCompaction(
  store: ReturnType<typeof createAgentStore>,
  timeoutMs = 30_000,
): Promise<ReturnType<typeof store.getState>> {
  const done = (): boolean =>
    store.getState().lastCompaction !== null || !store.getState().compacting;
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('等压缩结束超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.getState();
}

// ─── kernel.setModel()：那道「先查存在」的闸 ───

test('kernel.setModel：找不到那个模型时不 dispatch（状态原封不动）', async () => {
  const kernel = await createKernel({ provider: 'faux', demo: true, cwd: process.cwd(), writeSession: false });
  try {
    const before = kernel.store.getState();
    const ok = kernel.setModel('faux', '根本不存在这个模型');
    assert.equal(ok, false, '找不到就该返回 false');
    const after = kernel.store.getState();
    // 「原封不动」要验的是**模型那块**：标识、能力、窗口都得与换之前一致。
    assert.equal(after.modelId, before.modelId);
    assert.equal(after.providerName, before.providerName);
    assert.deepEqual(after.model, before.model);
  } finally {
    kernel.dispose();
  }
});

test('kernel.setModel：换成了就真的换了（底栏那一栏会变）', async () => {
  const kernel = await createKernel({ provider: 'faux', demo: true, cwd: process.cwd(), writeSession: false });
  try {
    // demo 装配的 runtime 里只有 faux 那一个模型，所以「换到自己」是唯一可换的目标；
    // 这里验的是**那条路能走通**（能力与窗口一起被装上），不是「换了个不一样的」。
    const current = kernel.store.getState();
    const ok = kernel.setModel(current.providerName, current.modelId);
    assert.equal(ok, true, '换到当前这个模型应当成功');
    const after = kernel.store.getState();
    assert.equal(after.modelId, current.modelId);
    assert.equal(after.model.seeded, true, 'model.init 装过后 seeded 为 true');
    // deepEqual 而不是 equal：能力是一个**对象**，而这个测试是同一个文件里唯一
    // 忘了写 deepEqual 的地方（症状是「形状完全一样却报不相等」，能卡半天）。
    assert.deepEqual(
      after.model.capabilities,
      current.model.capabilities,
      '换到同一个模型时能力不应变化',
    );
    assert.equal(
      after.model.contextWindow,
      current.model.contextWindow,
      '窗口也不应变化',
    );
  } finally {
    kernel.dispose();
  }
});

// ─── 作用域（/scoped-models 的解析） ───

test('scopeFrom：null = 全开，面板拿不到条目（由组件自己列全部）', () => {
  const scope = scopeFrom(null, undefined);
  assert.equal(scope.enabledModelIds, null);
  assert.deepEqual(scope.models, [], '全开时不预先列条目');
});

test('scopeFrom：按 provider/id 解析出模型条目', () => {
  const { runtime } = twoModelRuntime();
  const provider = runtime.spec.provider;
  const scope = scopeFrom([`${provider}/model-b`], runtime);
  assert.equal(scope.models.length, 1);
  assert.equal(scope.models[0]?.model.id, 'model-b');
  assert.equal(scope.models[0]?.thinkingLevel, undefined, '没写级别时不应有这一项');
});

test('scopeFrom：`provider/id:high` 的级别被拆出来（思考级别要跟着走）', () => {
  const { runtime } = twoModelRuntime();
  const provider = runtime.spec.provider;
  const scope = scopeFrom([`${provider}/model-b:high`], runtime);
  assert.equal(scope.models.length, 1, '级别后缀不能被当成 id 的一部分');
  assert.equal(scope.models[0]?.model.id, 'model-b');
  assert.equal(scope.models[0]?.thinkingLevel, 'high');
});

test('scopeFrom：model id 里本来就有冒号时不当成级别（网关的 x:exacto 这类 id）', () => {
  // 这是个真会踩的坑：网关的模型 id 带冒号（`openai/gpt-oss:120b`）很常见。
  // 把 `:120b` 当级别剥掉之后会去找一个不存在的 id —— 而那条配置本来是好的，
  // 于是「我明明配了」却面板里空着。
  const faux = fauxProvider({ models: [{ id: 'weird:id', contextWindow: 10 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime: AgentRuntime = {
    models,
    spec: { provider: faux.provider.id, model: 'weird:id' },
    model: faux.getModel(),
  };
  const scope = scopeFrom([`${faux.provider.id}/weird:id`], runtime);
  assert.equal(scope.models.length, 1, '不该因为 id 带冒号就丢掉这一条');
  assert.equal(scope.models[0]?.model.id, 'weird:id');
});

test('scopeFrom：解析不出来的 id 被**丢掉**而不是编一条假条目', () => {
  const { runtime } = twoModelRuntime();
  const provider = runtime.spec.provider;
  const scope = scopeFrom([`${provider}/model-a`, `${provider}/早就不在了`], runtime);
  // 列表短了 —— 那是**如实**的。编一条假条目会让「循环集里有个打不动的模型」，
  // 症状是 Ctrl+P 循环到那儿就卡住。
  assert.equal(scope.models.length, 1);
  assert.equal(scope.models[0]?.model.id, 'model-a');
  // 但**启用列表本身**原样留着（那是用户配的东西，不该被我们改）。
  assert.equal(scope.enabledModelIds?.length, 2);
});

test('scopeFrom：没有 runtime 时按裸 id 也认（降级路径不能空着面板）', () => {
  // 降级路径（ModelRuntime.create() 失败）拿不到快照，于是解析不出任何模型。
  // 那时面板仍要能开 —— 症状是「按 /model 什么都没有」比「列得少」糟得多。
  const scope = scopeFrom(['model-a', 'model-b'], undefined);
  assert.equal(scope.models.length, 0, '没 runtime 就解析不出模型对象');
  assert.equal(scope.enabledModelIds?.length, 2, '但启用列表仍如实保留');
});

test('readScopedModels：没配 / 配坏时是 null（= 全开），不抛', () => {
  // `PI_CODING_AGENT_DIR` 在测试里指向临时目录（见 test/isolated-home.ts），
  // 那个目录里没有 settings.json —— 所以这里走的就是「读不到」那条路。
  assert.equal(readScopedModels(process.cwd()), null);
});
