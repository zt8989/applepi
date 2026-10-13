/**
 * models.json：对象 map 的 `models` → 数组（pi 新版 schema）。
 *
 * ## 为什么要迁
 *
 * pi 现在要求 `providers.<id>.models` 是**数组**：
 *
 *     "models": [ { "id": "…", "contextWindow": … }, … ]
 *
 * 我们（以及旧版 pi 的文档）一直用**对象 map**：
 *
 *     "models": { "<modelId>": { "id": "…", … }, … }
 *
 * 两种形状都能表达同一批模型，但 pi 的 `ModelConfig.load()` 会用 TypeBox 校验，
 * 形状不对就整个文件作废（一个 provider 都不装），报：
 *
 *     Invalid models.json schema:
 *       - providers.workbuddy.models: must be array
 *
 * ## 迁移做什么、不做什么
 *
 * 只改 `models` 的容器形状，**一个字段都不动** —— id / baseUrl / api / contextWindow /
 * maxTokens / input / output 全部原样搬过去。对象 map 的 key 本来就等于 `id`
 * （那是 pi 早期要求的隐含约定），数组形式里 `id` 是显式字段，所以搬的时候
 * 以值里的 `id` 为准（它才是权威），漏写时才用 key 兜底。
 *
 * 幂等：已经是数组就原样返回（调用方据此知道不用写盘）。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** models.json 里我们认识的那部分（其余字段原样透传，不列出来）。 */
interface ModelDefinition {
  id?: string;
  [key: string]: unknown;
}

interface ProviderConfig {
  models?: ModelDefinition[] | Record<string, ModelDefinition>;
  [key: string]: unknown;
}

interface ModelsConfig {
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

/** 迁一个 provider 条目（只改 models 的容器形状，其余原样）。 */
function migrateProvider(provider: ProviderConfig): ProviderConfig {
  const { models, ...rest } = provider;
  if (models === undefined) return provider;
  if (Array.isArray(models)) return { ...provider, models };
  if (models === null) return { ...provider, models: [] };
  if (typeof models !== 'object') throw new Error(`models 既不是对象也不是数组：${typeof models}`);

  return {
    ...rest,
    models: Object.entries(models).map(([key, value]) => {
      const model: ModelDefinition =
        value && typeof value === 'object' ? value : ({} as ModelDefinition);
      // 值里的 id 优先（它才是权威）；漏写时用 map 的 key 兜底。
      return typeof model.id === 'string' && model.id.length > 0 ? model : { ...model, id: key };
    }),
  };
}

/** 迁一个 models.json 的内容（就地改）。返回是否真的改了。 */
export function migrateModelsConfig(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const file = config as ModelsConfig;
  if (!file.providers || typeof file.providers !== 'object') return false;

  let changed = false;
  const providers: Record<string, ProviderConfig> = {};
  for (const [providerId, provider] of Object.entries(file.providers)) {
    const before = provider?.models;
    providers[providerId] = migrateProvider(provider ?? {});
    // 只有「本来是对象 map」才算真改了；undefined（没这个字段）与数组都不用动。
    if (before !== undefined && before !== null && !Array.isArray(before)) changed = true;
  }
  if (!changed) return false;
  file.providers = providers;
  return true;
}

/** 就地迁一个文件。返回是否真的改了（幂等）。 */
export function migrateModelsFile(file: string): boolean {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!migrateModelsConfig(config)) return false;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}

// CLI：node --import tsx scripts/migrate-models.ts <models.json 路径>
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/migrate-models.ts')) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('用法：node --import tsx scripts/migrate-models.ts <models.json>\n');
    process.exitCode = 2;
  } else {
    console.log(
      migrateModelsFile(target) ? `已迁移：${target}` : `无需迁移（已是数组或无 providers）：${target}`,
    );
  }
}