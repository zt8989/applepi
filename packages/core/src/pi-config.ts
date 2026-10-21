/**
 * 配置目录：读 `~/.pi/agent/` 下的 provider / 凭证 / 默认值。
 *
 * 主路径直接用 pi-coding-agent 的 `ModelRuntime`（读 models.json + auth.json + 装配 provider
 * 的官方实现），换来 44 个内置 provider、1500+ 模型目录、schema 校验、凭证优先级与协议适配，
 * 这些手写维护不来。代价是 `import` 整个包要 ~2.6s，对交互式 CLI 可以接受。
 *
 * 手写路径（`createModelsWithPiConfig`）留着有两个用途：**测试**（离线、不碰真实家目录）
 * 与**降级**（`ModelRuntime` 构造失败时至少还能用自定义 provider）。
 *
 * models.json 的 `models` 有两种形状：pi 新版要求**数组**，旧版（与手写配置）是**对象 map**
 * （`{"some-id": {...}}`）。`ModelRuntime` 只认数组，所以手写路径与 `normalizeModels()` 负责
 * 归一，并在读时顺手把盘上那份改成数组 —— 否则 pi 读同一个文件时整个文件作废。
 */
import { existsSync, readFileSync } from 'node:fs';
import { authPath, configHome, modelsPath, settingsPath, writeJson } from './config-home';
import path from 'node:path';
import { createProvider, createModels, type Model, type Models, type Provider } from '@earendil-works/pi-ai';
import { envApiKeyAuth } from '@earendil-works/pi-ai';
import { streamSimple as openaiCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as openaiResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';

/**
 * 配置家目录 —— 直接调 pi 的 `getAgentDir()`（`~/.pi/agent`），环境变量只认它的
 * `PI_CODING_AGENT_DIR`。抄一份 `join(homedir(), '.pi', 'agent')` 的风险是 pi 改了实现
 * 而我们静默指向别处，症状是「改了一边另一边读不到」。见 `config-home.ts`。
 */
export function piAgentDir(): string {
  return configHome();
}

/** `<家目录>/models.json`（与 pi 的 `getModelsPath()` 同一路径规则）。 */
export function piModelsPath(): string {
  return modelsPath();
}

/** `<家目录>/auth.json`（与 pi 的 `getAuthPath()` 同一路径规则）。 */
export function piAuthPath(): string {
  return authPath();
}

/** `<家目录>/settings.json`（与 pi 的 `getSettingsPath()` 同一路径规则）。 */
export function piSettingsPath(): string {
  return settingsPath();
}

/**
 * models.json 里的一个 provider 条目（只声明我们真会用到的字段）。
 *
 * `models` 两种形状都收，见文件头的说明。
 */
export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** pi 新版：数组。旧版：`<modelId> → 定义` 的对象 map。 */
  models?: PiModelConfig[] | Record<string, PiModelConfig>;
}

export interface PiModelConfig {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  output?: string[];
}

export interface PiModelsFile {
  providers: Record<string, PiProviderConfig>;
}

/**
 * 归一成数组。**两种形状都收**：数组（pi 新版）与对象 map（旧版 / 手写）。
 *
 * 收旧形状的理由：pi 只认数组，搞错的后果是**整个 models.json 作废**（schema 报错、
 * 一个 provider 都不装）。map 的 key 本来就等于 `id`，所以以 key 兜底、值里的 `id` 优先。
 */
export function normalizeModels(
  models: PiProviderConfig['models'],
): PiModelConfig[] {
  if (!models) return [];
  if (Array.isArray(models)) {
    return models.filter((m): m is PiModelConfig => !!m && typeof m === 'object');
  }
  return Object.entries(models).map(([modelId, model]) => {
    const value = model && typeof model === 'object' ? model : ({} as PiModelConfig);
    // 值里的 id 优先（它才是权威）；漏写时用 map 的 key 兵底。
    return value.id ? value : { ...value, id: modelId };
  });
}

/** auth.json：`{ "<providerId>": { "type": "api_key", "key": "…" } }` */
export type PiAuthFile = Record<string, { type: string; key?: string }>;

function readJsonIfExists<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new Error(`读 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadPiModels(): PiModelsFile | null {
  return readJsonIfExists<PiModelsFile>(piModelsPath());
}

/**
 * 读 models.json 并把它**归一 + 落盘**。
 *
 * 要写回盘：旧的 `models: { map }` 形状 pi 不认，而配置家目录与 pi 同址 —— 我们的文件用旧
 * 形状就会让 pi 整个加载失败。读的时候顺手改成 pi 现在的形状，一次性了事。
 *
 * 幂等（已是数组就什么都不做）；写回失败也不抛 —— 内存里的配置已经能用。
 */
export function loadPiModelsNormalized(): PiModelsFile | null {
  const file = loadPiModels();
  if (!file) return null;
  let needsRewrite = false;
  for (const provider of Object.values(file.providers ?? {})) {
    if (provider?.models && !Array.isArray(provider.models)) needsRewrite = true;
  }
  if (needsRewrite) {
    try {
      writeJson(piModelsPath(), {
        ...file,
        providers: Object.fromEntries(
          Object.entries(file.providers ?? {}).map(([providerId, provider]) => [
            providerId,
            { ...provider, models: normalizeModels(provider.models) },
          ]),
        ),
      });
    } catch (error) {
      process.stderr.write(
        `models.json 形状已归一，但写回失败（不影响本次运行）：${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  return file;
}

/**
 * 用 pi 自己的 `ModelConfig` 校验 models.json。
 *
 * 归一（`normalizeModels()`）只管「旧的对象 map」这一种形状，pi 的 schema 还有别的约束
 * （`id` 非空、`api` 是字符串…）。形状再出问题的话 pi 读同一个文件会**整个文件作废**
 * （一个 provider 都不装），症状是「怎么一个 provider 都没有」，很难往配置格式上想。
 *
 * 主路径本来就会校验并抛错；这里是给降级路径用的 —— 它要「尽量能用」，所以只警告不抛。
 *
 * @returns 校验错误文本；`undefined` = 通过（或文件不存在）。
 */
export async function validateModelsFile(): Promise<string | undefined> {
  const file = piModelsPath();
  if (!existsSync(file)) return undefined;
  try {
    const { ModelConfig } = await import('@earendil-works/pi-coding-agent/dist/core/model-config.js');
    const config = await ModelConfig.load(file);
    const error = config.getError();
    if (error) {
      process.stderr.write(
        `models.json 校验未通过（pi 会拒绝整个文件，下面这些 provider 可能都用不了）：\n${error}\n`,
      );
    }
    return error;
  } catch (error) {
    // 校验器自己坏了不该连带配置也用不了 —— 记一句继续。
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`models.json 校验器不可用（跳过校验）：${message}\n`);
    return undefined;
  }
}

export function loadPiAuth(): PiAuthFile {
  return readJsonIfExists<PiAuthFile>(piAuthPath()) ?? {};
}

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  /**
   * 界面主题。与 pi 用**同一个键、同一个配置文件**（`~/.pi/agent/settings.json`）。
   *
   * 认这些形式：`"dark"` / `"light"` / `"auto"` / `"light:dark, dark:light"`，
   * 也可以是 pi 自定义主题目录里的主题名。解析规则在 `packages/tui/src/theme.ts` 里，
   * 与 pi 的 `resolveThemeSetting()` 同一条代码路径。
   */
  theme?: string;
  /**
   * 默认开启哪些内置工具（与 pi 用**同一个键、同一个配置文件**）。语义照抄 pi 的
   * `resolveDefaultTools()`（见 `tools.ts` 的 `resolveToolSelection`）：
   * - 不给 → `["read","bash","edit","write"]`；
   * - 出现不带前缀的名字 → 整份清单**替换**默认那份；
   * - 只有 `+name` / `-name` → 在默认那份上按顺序增删（`…,"+grep"` = 加上 grep）。
   *
   * 官方读**多层** settings（项目 / 全局 / 内置），本项目只认这一个文件：规则一致，
   * 最终清单与 pi 相同，只是没有项目级覆盖层。
   */
  defaultTools?: string[];
}

export function loadPiSettings(): PiSettings {
  return readJsonIfExists<PiSettings>(piSettingsPath()) ?? {};
}

/**
 * 按 api 名取 streamSimple 实现。
 *
 * 只接三个 —— 它们覆盖了现网几乎所有的 OpenAI 兼容网关（本项目的 workbuddy 就是
 * `openai-completions`）。遇到别的 api 明确报错，不静默降级：猜错 api 会让请求
 * 发到错误的协议上，报错比错答好。
 */
function streamForApi(api: string): {
  streamSimple: (model: Model<any>, context: never, options?: never) => never;
} {
  switch (api) {
    case 'openai-completions':
      return { streamSimple: openaiCompletionsStreamSimple as never };
    case 'openai-responses':
      return { streamSimple: openaiResponsesStreamSimple as never };
    case 'anthropic-messages':
      return { streamSimple: anthropicStreamSimple as never };
    default:
      throw new Error(
        `暂不支持的 api：${api}。已支持 openai-completions / openai-responses / anthropic-messages。`,
      );
  }
}

/** 环境变量名：`<ID>_API_KEY`（同 pi 的 envApiKeyAuth 规则）。 */
function envVarFor(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * 把 models.json 里的一个条目装配成 pi-ai 的 `Provider`。
 *
 * auth 用 `envApiKeyAuth`：它按 `<ID>_API_KEY` 读环境变量。要带 key 就用真环境变量
 * （或 `ela --api-key`，它也是写进环境变量的），**不读 `.env`**。
 * 若 models.json 的条目里直接写了 `apiKey`，优先用它（自包含，连环境变量都不需要）。
 */
export function buildProvider(
  providerId: string,
  config: PiProviderConfig,
  auth: PiAuthFile,
): Provider<any> {
  const api = config.api ?? 'openai-completions';
  const models: Model<any>[] = normalizeModels(config.models).map((m) => ({
    ...m,
    id: m.id,
    provider: providerId,
    api: (m.api ?? api) as never,
    // baseUrl 可以按模型覆盖（多网关场景），否则沿用 provider 的。
    baseUrl: m.baseUrl ?? config.baseUrl,
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 32_000,
    reasoning: m.reasoning ?? false,
    // Model.cost 是必填的。自定义网关通常不给价目表，全 0 ——
    // 它只影响 usage 里的费用估算，不影响请求本身。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })) as unknown as Model<any>[];

  // `auth` 的形状是 `{ apiKey?: ApiKeyAuth }`，而 `ApiKeyAuth` 必须有 `resolve()`
  // （它返回 `{auth: {apiKey}}`）。显式 key（auth.json / 条目内 / 环境变量）都走
  // 同一个 resolve —— 手写一个「只认某个 key」的版本反而会漏掉 env 的那条路。
  //
  // 优先级：条目内 apiKey > auth.json 的 key > `<ID>_API_KEY` 环境变量。
  // 不读 `.env`（见 resolveApiKey 的注释：那个口子会把别的项目的 key 发出去）。
  const explicit = config.apiKey ?? auth[providerId]?.key;
  const envVar = envVarFor(providerId);
  const apiKeyAuth = explicit
    ? {
        name: config.name ?? providerId,
        async resolve() {
          return explicit ? { auth: { apiKey: explicit }, source: 'models.json' } : undefined;
        },
      }
    : envApiKeyAuth(config.name ?? providerId, [envVar]);

  return createProvider({
    id: providerId,
    name: config.name ?? providerId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    auth: { apiKey: apiKeyAuth as never },
    models: models as never,
    api: { stream: (() => {
      throw new Error(`${providerId}：不提供流式 stream，只提供 streamSimple`);
    }) as never, ...streamForApi(api) } as never,
  });
}

/**
 * 把 models.json 里的**全部** provider 装进一个 `Models`（含传入的 `extra` 内置 provider）。
 *
 * 这是**降级 / 测试**路径，不是主路径（主路径是 `createPiModelRuntime()`）：离线测试要一个
 * 不碰网络、不依赖真实家目录的 Models；`ModelRuntime.create()` 失败时也得能用自定义 provider。
 *
 * 所以它**故意不注册内置 provider 目录** —— 那正是 `ModelRuntime` 的价值，手写一遍既慢又会
 * 过期。要内置 provider 就自己传 `extra`。
 */
export async function createModelsWithPiConfig(extra: (() => Provider<any>)[] = []): Promise<Models> {
  const models = createModels();
  // 先让 pi 的校验器看一眼（只警告不抛 —— 这条路径的宗旨是「尽量能用」）。
  // 不校验的话，配置形状再出问题时的症状是「一个 provider 都没有」，很难往格式上想。
  await validateModelsFile();
  // 走 loadPiModelsNormalized：顺手把旧形状的 models 改成 pi 现在的数组形状。
  const file = loadPiModelsNormalized();
  if (file) {
    const auth = loadPiAuth();
    for (const [providerId, config] of Object.entries(file.providers ?? {})) {
      try {
        models.setProvider(buildProvider(providerId, config, auth));
      } catch (error) {
        // 一个坏 provider 不该让全部不可用 —— 记下来继续。
        process.stderr.write(
          `跳过 provider ${providerId}：${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  for (const factory of extra) {
    const provider = factory();
    models.setProvider(provider);
  }
  return models;
}

// ─── 主路径：pi-coding-agent 的 ModelRuntime ───

/**
 * ModelRuntime 的最小面。只声明本项目真正用到的那几个方法，
 * 而不是把整个 pi-ai `Models` 接口搬过来 —— 好处是接口加了新方法时我们不受影响。
 */
export interface PiModelRuntime {
  /** 列出某 provider 的模型；不传 providerId 则列全部。 */
  getModels(providerId?: string): readonly { id: string; provider: string }[];
  getModel(providerId: string, modelId: string): Model<any> | undefined;
  /** 某 provider 是否已配到凭证（models.json > auth.json > <ID>_API_KEY）。 */
  hasConfiguredAuth(providerId: string): boolean;
  /** 取这个模型该用的凭证（含 OAuth）。 */
  getAuth(model: Model<any>): Promise<{ auth: Record<string, unknown>; source?: string } | undefined>;
  /** 发起一次流式请求。api 名 → 协议的映射是它做的。 */
  streamSimple(
    model: Model<any>,
    context: unknown,
    options?: unknown,
  ): AsyncIterable<{ type: string; [key: string]: unknown }>;
  /** 全部 provider 的 id（含内置的 44 个与 models.json 里的自定义）。 */
  getProviders(): readonly { id: string }[];
  /** models.json 的加载错误（形状不对等），undefined = 正常。 */
  getError(): string | undefined;
  /** 当前可用模型快照。 */
  getAvailableSnapshot(): readonly Model<any>[];
}

/**
 * 建 ModelRuntime —— **主装配路径**，读 ~/.pi/agent 的 provider / 凭证。
 *
 * 传 `modelsPath: null` 表示「不读 models.json，只用内置 provider 目录」——
 * 离线测试用这个，它不碰用户家目录。
 */
export async function createPiModelRuntime(options: { modelsPath?: string | null } = {}): Promise<PiModelRuntime> {
  // 动态 import：这个包会把整个 pi CLI（含 TUI）拉进来（约 2.6s），
  // 而测试里走手写路径根本不需要它。静态 import 会让每次启动都付这个代价。
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({
    ...(options.modelsPath !== undefined ? { modelsPath: options.modelsPath } : {}),
  });
  const error = runtime.getError();
  if (error) {
    throw new Error(`ModelRuntime 读配置失败：${error}（文件：${piModelsPath()}）`);
  }
  return runtime as unknown as PiModelRuntime;
}
