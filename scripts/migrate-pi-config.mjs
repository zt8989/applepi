#!/usr/bin/env node
/**
 * 把 clj-harness 的 provider / 模型配置迁到 pi 的配置目录。
 *
 * 源：`~/.clj-harness/config.edn`（EDN）+ `~/.clj-harness/.env`（key）
 * 目标：`~/.pi/agent/models.json` + `~/.pi/agent/auth.json`（路径与格式都按 pi 的约定，
 *       见 pi-coding-agent 的 dist/config.js：`getAgentDir()` / `getModelsPath()` / `getAuthPath()`）
 *
 * ## 字段对应
 *
 *   config.edn                          →  models.json
 *   ──────────────────────────────         ────────────────────────────────
 *   :providers.<id>:protocol            →  providers.<id>.api
 *   :providers.<id>:base-url            →  providers.<id>.baseUrl
 *   :providers.<id>:model               →  providers.<id>.models 里那个模型的条目
 *   :providers.<id>:models.<mid>:…      →  providers.<id>.models.<mid>
 *     :context-window                     contextWindow
 *     :max-output-tokens                  maxTokens
 *     :input / :output                    input / output（`#{:image :text}` → `["image","text"]`）
 *     :reasoning                          reasoning（由 :input/:output 推断不了就不写）
 *
 *   auth.json：只存 key，格式是 `{ "<providerId>": { "type": "api_key", "key": "..." } }`
 *   —— baseUrl **不在** auth.json 里（在 models.json），这点别搞混。
 *
 * ## key 从哪来
 *
 * pi 的 provider id 是 `workbuddy` 这种小写，auth.json 的 key 名也用它；
 * `.env` 里的变量名是 `WORKBUDDY_API_KEY`。所以按 `<ID>_API_KEY` 找。
 * 找不到就不写那条 —— 宁可不写，也不要写一个空 key 假装配好了。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEdn, dig, asString, asStringSet } from "./edn.mjs";

const BOLD = "[1m";
const DIM = "[2m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RED = "[31m";
const RESET = "[0m";
const paint = (c, s) => (process.env.NO_COLOR ? s : `${c}${s}${RESET}`);

/** pi 的配置目录：默认 ~/.pi/agent，可用 PI_CODING_AGENT_DIR 搬走（同 pi 的约定）。 */
function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? path.resolve(env) : path.join(homedir(), ".pi", "agent");
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const srcDir = opt("--src") ?? path.join(homedir(), ".clj-harness");
const dryRun = flag("--dry-run");
const overwrite = flag("--overwrite");

const configPath = path.join(srcDir, "config.edn");
const envPath = path.join(srcDir, ".env");

if (!existsSync(configPath)) {
  process.stderr.write(`${paint(RED, `找不到 ${configPath}`)}\n`);
  process.exit(1);
}

const edn = parseEdn(readFileSync(configPath, "utf8"));

// ── .env → { VAR_NAME: value } ──
// 不引 dotenv：格式简单（KEY=VALUE / # 注释 / 可选引号），几十行就够且没有依赖。
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};

/** 读一个 provider 的模型条目，转成 pi 的模型定义。 */
function toModelDef(id, spec, providerProtocol) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec) || spec instanceof Set) {
    throw new Error(`模型 ${id} 的定义不是 map`);
  }
  const out = { id };
  // context-window / max-output-tokens 是 EDN 里的 kebab-case，pi 里是 camelCase。
  const contextWindow = spec["context-window"];
  if (typeof contextWindow === "number") out.contextWindow = contextWindow;
  const maxOutput = spec["max-output-tokens"];
  if (typeof maxOutput === "number") out.maxTokens = maxOutput;

  const input = asStringSet(spec.input);
  if (input && input.length > 0) out.input = input;
  const output = asStringSet(spec.output);
  if (output && output.length > 0) out.output = output;

  // `api` 可以按模型覆盖，否则沿用 provider 的 protocol。
  const api = asString(spec.api) ?? (providerProtocol ? String(providerProtocol) : undefined);
  if (api) out.api = api;

  // `:reasoning true` 直接搬；没写就不写（别猜 —— 猜错会让 pi 传错参数）。
  if (typeof spec.reasoning === "boolean") out.reasoning = spec.reasoning;
  // instruction-updates 是 clj-harness 自己的概念，pi 没有对应字段，不搬。
  return out;
}

const providersNode = dig(edn, "providers");
if (providersNode === undefined) {
  process.stderr.write(`${paint(RED, "config.edn 里没有 :providers")}\n`);
  process.exit(1);
}

const models = { providers: {} };
const auth = {};
const warnings = [];

for (const [providerId, pRaw] of Object.entries(providersNode)) {
  if (pRaw === null || typeof pRaw !== "object" || Array.isArray(pRaw) || pRaw instanceof Set) continue;

  const protocol = asString(pRaw.protocol);
  const baseUrl = asString(pRaw["base-url"]);

  const entry = {};
  if (baseUrl) entry.baseUrl = baseUrl;
  if (protocol) entry.api = protocol;

  // 该 provider 的模型目录
  const modelSpecs = pRaw.models;
  const ids = [];
  if (modelSpecs !== null && typeof modelSpecs === "object" && !Array.isArray(modelSpecs) && !(modelSpecs instanceof Set)) {
    for (const [modelId, spec] of Object.entries(modelSpecs)) {
      entry.models ??= {};
      entry.models[modelId] = toModelDef(modelId, spec, protocol);
      ids.push(modelId);
    }
  }

  // provider 自己的 `:model` 若不在目录里，补一条最小的（否则 pi 解析默认模型会找不到）。
  const providerDefault = asString(pRaw.model);
  if (providerDefault && entry.models && !entry.models[providerDefault]) {
    entry.models[providerDefault] = { id: providerDefault, ...(protocol ? { api: protocol } : {}) };
    warnings.push(`${providerId} 的默认模型 ${providerDefault} 不在 :models 里，按最小条目补上`);
  }

  models.providers[providerId] = entry;

  // key：`<ID>_API_KEY`（ID 大写，非字母数字换下划线，同 pi 的 envApiKeyAuth 规则）
  const envName = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  if (env[envName]) {
    auth[providerId] = { type: "api_key", key: env[envName] };
  } else {
    warnings.push(`${providerId}：.env 里没有 ${envName}，auth.json 不写这条（未配置）`);
  }
}

const def = dig(edn, "default");
const defaultProvider = asString(def?.provider);
const defaultModel = asString(def?.model);
const reasoningEffort = asString(def?.["reasoning-effort"]);

// 顺带把 pi 侧的 settings.json 写上，让 UI 默认就选中它。
const settings = {
  ...(defaultProvider ? { defaultProvider } : {}),
  ...(defaultModel ? { defaultModel } : {}),
  ...(reasoningEffort ? { defaultThinkingLevel: reasoningEffort } : {}),
};

const dir = agentDir();
const modelsPath = path.join(dir, "models.json");
const authPath = path.join(dir, "auth.json");
const settingsPath = path.join(dir, "settings.json");

if (!overwrite && existsSync(modelsPath) && !dryRun) {
  process.stderr.write(
    `${paint(YELLOW, `${modelsPath} 已存在。`)}\n` +
      `${paint(DIM, "加 --overwrite 覆盖，或先备份那个文件。")}\n`,
  );
  process.exit(1);
}

const providerCount = Object.keys(models.providers).length;
const authCount = Object.keys(auth).length;

process.stdout.write(
  [
    `${paint(BOLD, "迁移预览")}  ${paint(DIM, `源 ${configPath}`)}`,
    `  pi 配置目录  ${dir}`,
    `  provider     ${providerCount} 个 —— ${Object.keys(models.providers).join(', ')}`,
    `  auth 条目    ${authCount} 个 —— ${Object.keys(auth).join(', ') || '(无)'}`,
    `  默认         ${defaultProvider ?? '(无)'} / ${defaultModel ?? '(无)'}`,
    defaultReasoningLine(reasoningEffort),
    "",
    ...warnings.map((w) => `  ${paint(YELLOW, '!')} ${w}`),
    ...(warnings.length > 0 ? [""] : []),
    ...(dryRun ? [paint(DIM, "  （--dry-run：没有写任何文件）")] : []),
    "",
  ]
    .filter((l) => l !== null)
    .join("\n"),
);

function defaultReasoningLine(effort) {
  return effort ? `  reasoning    ${effort}` : "";
}

if (dryRun) process.exit(0);

mkdirSync(dir, { recursive: true });
writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");
writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

process.stdout.write(
  [
    paint(GREEN, "已写入："),
    `  ${modelsPath}`,
    `  ${authPath}`,
    `  ${settingsPath}`,
    "",
    paint(DIM, "下一步：npm start -- -P workbuddy -m cn:space-bunny"),
    "",
  ].join("\n"),
);
