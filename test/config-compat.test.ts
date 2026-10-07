import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildProvider,
  createModelsWithPiConfig,
  createPiModelRuntime,
  loadPiModels,
  loadPiModelsNormalized,
  normalizeModels,
} from '../src/pi-config';
import { migrateModelsConfig } from '../scripts/migrate-models';

/**
 * 配置兼容：与 pi 共用 `~/.pi/agent` 之后的形状与迁移，以及主路径复用
 * pi-coding-agent 的 `ModelRuntime`。
 *
 * ## 背景
 *
 * 配置家目录从 `~/.redux-agent` 改成与 pi 同址，于是**同一个 models.json 两边都要读**。
 * pi 的 `ModelConfig.load()` 用 TypeBox 校验，形状不对就**整个文件作废**（一个 provider
 * 都不装），报：
 *
 *     Invalid models.json schema:
 *       - providers.workbuddy.models: must be array
 *
 * pi 现在要求 `models` 是数组，本项目（以及给别的工具写的配置）历史上用的是对象 map。
 * 这组测试守住「两种形状都能读」和「读的时候顺手把盘上那份改成 pi 要的形状」。
 *
 * 跑在 `test/isolated-home.ts` 指好的临时家目录（PI_CODING_AGENT_DIR）里，不碰真配置。
 */

// ─── normalizeModels：两种形状都收 ───

test('normalizeModels：数组形状原样收下（pi 新版）', () => {
  const models = [{ id: 'a' }, { id: 'b', contextWindow: 1000 }];
  assert.deepEqual(normalizeModels(models), models);
});

test('normalizeModels：对象 map 也收（map 的 key 当 id 兵底）', () => {
  const models = normalizeModels({ 'cn:space-bunny': { id: 'cn:space-bunny', maxTokens: 524288 } });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, 'cn:space-bunny');
  assert.equal(models[0]?.maxTokens, 524288);
});

test('normalizeModels：map 里漏写 id 时用 key 补上（否则装出来的模型没有 id）', () => {
  // 磁盘上的旧配置完全可能缺 id（它当时是 map 的 key，形状本身不要求 id）。
  const models = normalizeModels({ 'some-model': { maxTokens: 100 } } as never);
  assert.equal(models[0]?.id, 'some-model');
});

test('normalizeModels：值里的 id 优先于 map 的 key（值才是权威）', () => {
  const models = normalizeModels({ 'key-name': { id: 'real-id', maxTokens: 100 } });
  assert.equal(models[0]?.id, 'real-id');
});

test('normalizeModels：缺失 / null / 数组里的垃圾项都不崩', () => {
  assert.deepEqual(normalizeModels(undefined), []);
  assert.deepEqual(normalizeModels(null as never), []);
  // 数组里的非对象项直接滤掉 —— 不因为一个脏项丢掉整个 provider。
  assert.deepEqual(normalizeModels([{ id: 'a' }, null, undefined] as never), [{ id: 'a' }]);
});

test('buildProvider：对象 map 的 models 也能装出模型（旧配置不失效）', () => {
  const provider = buildProvider(
    'legacy',
    {
      baseUrl: 'http://example.invalid/v1',
      api: 'openai-completions',
      models: { 'm1': { id: 'm1', contextWindow: 1000, maxTokens: 100 } },
    },
    {},
  );
  // Provider 上的模型走 getModels()（不是 .models 属性）。
  const models = provider.getModels();
  assert.deepEqual(models.map((m) => m.id), ['m1']);
  assert.equal(models[0]?.baseUrl, 'http://example.invalid/v1', 'baseUrl 从 provider 继承');
  assert.equal(models[0]?.contextWindow, 1000);
});

// ─── 读的时候顺手改盘（否则 pi 读同一个文件会整个作废） ───

/** 造一个隔离家目录，返回它的 models.json 路径。 */
function withModelsFile(content: unknown): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'redux-agent-models-'));
  process.env['PI_CODING_AGENT_DIR'] = dir;
  const file = path.join(dir, 'models.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return { dir, file };
}

test('loadPiModelsNormalized：读到旧形状就把盘上那份改成数组（pi 才不会整个文件作废）', () => {
  const { file } = withModelsFile({
    providers: { p: { baseUrl: 'http://x/v1', models: { m1: { id: 'm1' } } } },
  });
  loadPiModelsNormalized();
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
    providers: { p: { models: unknown } };
  };
  assert.ok(Array.isArray(onDisk.providers.p.models), '盘上必须是数组，否则 pi 拒绝整个文件');
  assert.deepEqual(onDisk.providers.p.models, [{ id: 'm1' }]);
});

test('loadPiModelsNormalized：已是数组就一个字都不改（幂等，别动用户文件）', () => {
  const original = {
    providers: { p: { baseUrl: 'http://x/v1', api: 'openai-completions', models: [{ id: 'm1', maxTokens: 5 }] } },
  };
  const { file } = withModelsFile(original);
  loadPiModelsNormalized();
  const after = readFileSync(file, 'utf8');
  assert.equal(after, `${JSON.stringify(original, null, 2)}\n`, '已是数组就不该重写');
});

test('loadPiModelsNormalized：没有 models.json 也不抛（配置目录可能还没建）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'redux-agent-empty-'));
  process.env['PI_CODING_AGENT_DIR'] = dir;
  assert.equal(loadPiModels(), null);
  assert.equal(loadPiModelsNormalized(), null);
});

test('createModelsWithPiConfig：两种形状的 models.json 都能装出 provider', async () => {
  withModelsFile({
    providers: {
      asArray: { baseUrl: 'http://a/v1', api: 'openai-completions', models: [{ id: 'a1' }] },
      asMap: { baseUrl: 'http://b/v1', api: 'openai-completions', models: { b1: { id: 'b1' } } },
    },
  });
  const models = await createModelsWithPiConfig();
  assert.deepEqual(models.getModels('asArray').map((m) => m.id), ['a1']);
  assert.deepEqual(models.getModels('asMap').map((m) => m.id), ['b1']);
});

// ─── 一次性迁移脚本（把旧配置救活） ───

test('migrateModelsConfig：对象 map → 数组，字段一个不改', () => {
  const config = {
    providers: {
      p: {
        baseUrl: 'http://x/v1',
        api: 'openai-completions',
        models: {
          m1: { id: 'm1', contextWindow: 1000, maxTokens: 100, input: ['text'], output: ['text'] },
        },
      },
    },
  };
  assert.equal(migrateModelsConfig(config), true);
  assert.deepEqual(config.providers.p.models, [
    { id: 'm1', contextWindow: 1000, maxTokens: 100, input: ['text'], output: ['text'] },
  ]);
  assert.equal(config.providers.p.baseUrl, 'http://x/v1', 'provider 层的字段要留着');
  assert.equal(config.providers.p.api, 'openai-completions');
});

test('migrateModelsConfig：已是数组时报 false（调用方才知道不用写盘）', () => {
  const config = { providers: { p: { models: [{ id: 'm1' }] } } };
  assert.equal(migrateModelsConfig(config), false);
});

test('migrateModelsConfig：map 的 key 用来兵底缺失的 id', () => {
  const config = { providers: { p: { models: { 'only-in-key': { maxTokens: 1 } } } } };
  assert.equal(migrateModelsConfig(config), true);
  assert.deepEqual(config.providers.p.models, [{ id: 'only-in-key', maxTokens: 1 }]);
});

test('migrateModelsConfig：没有 providers 的文件不炸，也不改', () => {
  assert.equal(migrateModelsConfig({}), false);
  assert.equal(migrateModelsConfig(null), false);
});
// ─── 主路径：复用 pi-coding-agent 的 ModelRuntime ───

test('createPiModelRuntime：内置 provider 目录能装出来（不读 models.json 也能用）', async () => {
  // modelsPath: null = 只用内置目录，不碰用户家目录。
  const runtime = await createPiModelRuntime({ modelsPath: null });
  assert.equal(runtime.getError(), undefined, '不该有配置错误');
  // 内置目录里 deepseek / anthropic / openai 一定在 —— 这是复用换来的核心好处：
  // 手写时我们只列了三个，而且它们的模型目录（baseUrl/协议/价目表）全靠手抄。
  for (const providerId of ['deepseek', 'anthropic', 'openai']) {
    assert.ok(runtime.getModels(providerId).length > 0, `${providerId} 应该有内置模型`);
  }
});

test('createPiModelRuntime：内置目录远多于我们手列的三个', async () => {
  const runtime = await createPiModelRuntime({ modelsPath: null });
  assert.ok(
    runtime.getProviders().length >= 20,
    `内置 provider 应该至少有几十个，实际 ${runtime.getProviders().length}`,
  );
});

test('createPiModelRuntime：模型对象的字段是齐的（baseUrl/contextWindow/maxTokens）', async () => {
  const runtime = await createPiModelRuntime({ modelsPath: null });
  const model = runtime.getModel('deepseek', runtime.getModels('deepseek')[0]!.id);
  assert.ok(model, '应该能按 id 取到模型');
  // 这些字段是我们调用方真正依赖的（effects.ts 要 contextWindow 算轮数，
  // provider.ts 要 baseUrl 发请求）；ModelRuntime 装出来就该有。
  assert.equal(typeof model.baseUrl, 'string');
  assert.equal(typeof model.contextWindow, 'number');
  assert.equal(typeof model.maxTokens, 'number');
});

test('createPiModelRuntime：models.json 形状坏了时报错，而不是静默起一个空环境', async () => {
  // 派上用场的原因：pi 校验不过时是**整个文件作废**，不报就会变成
  // 「怎么一个 provider 都没有」这种难查的现象。
  const dir = mkdtempSync(path.join(tmpdir(), 'redux-agent-bad-'));
  process.env['PI_CODING_AGENT_DIR'] = dir;
  const file = path.join(dir, 'models.json');
  writeFileSync(file, JSON.stringify({ providers: { p: { models: 'not-an-array' } } }), 'utf8');
  await assert.rejects(
    () => createPiModelRuntime({ modelsPath: file }),
    /ModelRuntime 读配置失败|schema/i,
    '坏掉的 models.json 必须报出来',
  );
});
