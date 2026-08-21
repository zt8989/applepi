# Spec: 设置弹窗 + 模型配置（多提供方注册表）

> 设计来源：`/grill-with-docs` 4 轮 + domain-modeling，决策树见 `CONTEXT.md` LLM configuration 章节与 `docs/adr/0014-multi-provider-registry.md`。
> 状态：**设计已锁定，待实施**。本文是实施依据。

## 1. 目标

在 `apps/web` 增加「设置」弹窗（Modal），其「模型」页支持：
- 列出内置主流厂商（只读预设）+ 用户启用的提供方 + 自定义提供方；
- 每张提供方卡片可编辑：显示名称、API 密钥、API 地址、模型目录（获取可用模型 / 添加模型）；
- 「自定义提供方」弹窗：Provider ID（校验）/ 显示名称 / API 地址 / API 协议（下拉）/ API 密钥 / 模型目录；
- 右上「打开配置文件」按钮（仅本机显示，调 shell 默认编辑器打开 `settings.json`）；
- 对话页模型选择器改为「按提供方分组的二级列表」，预选 `lastUsedModel`。

底层 `packages/core/config.ts` 改为多提供方注册表（ADR-0014），`resolveLlmConfig` 取 `lastUsedModel` 并透传 `protocol`。

## 2. 数据结构（core，ADR-0014）

```ts
// packages/core/config.ts
export type ProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export interface ModelEntry { id: string; displayName: string; }

export interface ProviderConfig {
  displayName: string;
  protocol: ProviderProtocol;
  baseURL?: string;
  apiKeyRef: string;            // name into ~/.applepi/.env
  models?: ModelEntry[];        // optional managed catalog
  builtin?: boolean;            // true = builtin preset (not deletable)
}

export interface LlmSettings {
  providers: Record<string, ProviderConfig>;
  lastUsedModel?: { providerId: string; modelId: string };
}

export interface ResolvedLlmConfig {
  provider: string;             // display/grouping label only
  protocol: ProviderProtocol;  // selects SDK factory
  model: string;
  apiKey: string;
  baseURL?: string;
}
```

协议→工厂映射（集中在 core）：
| protocol | factory |
|---|---|
| `openai-completions` | `createOpenAI({apiKey, baseURL})` (chat completions) |
| `openai-responses` | `createOpenAI({apiKey, baseURL})` (responses API) |
| `anthropic-messages` | `createAnthropic({apiKey, baseURL})` |

内置预设 `BUILTIN_PROVIDERS`：`deepseek`(openai-completions) / `openai`(openai-completions) / `anthropic`(anthropic-messages) / `gemini`(openai-completions, baseURL openai-compatible) / `mistral`(openai-completions) / `zhipu`(智谱, openai-completions) / `qwen`(通义千问, openai-completions)。

`ProviderId` 约束（自定义）：`^[a-z][a-z0-9-]*$`，全局唯一（含内置）。

## 3. API 契约（apps/web）

新增/改造路由：
- `GET /api/config/providers` → 返回 `{ builtins: ProviderConfig[], user: ProviderConfig[] (含自定义), lastUsedModel }`（合并内置+用户，供设置弹窗渲染）。
- `PUT /api/config/providers` → body `{ providers: Record<id, ProviderConfig>, lastUsedModel? }`；写盘 `settings.json` + 同步 `.env`（`PROVIDER_<ID_UPPER>_API_KEY` 写入真实 key，其余 ref 不变）；成功后 `invalidateModel()`。校验 ProviderId 格式/唯一性。
- `GET /api/config/models?providerId=<id>` → 调 `{baseURL}/models`（仅 openai 两协议），返回 `ModelEntry[]`；anthropic 协议返回 405 + 提示。
- `POST /api/config/last-used` → body `{ providerId, modelId }`；写 `lastUsedModel` 到 `settings.json`。
- `POST /api/config/open-file` → 仅本机：exec `open`(mac)/`xdg-open`(linux) 打开 `settings.json`；非桌面环境返回 `{ hidden: true }`（前端据此隐藏按钮）。

保留：`GET /api/config`（现有，返回 active provider/model，改为返回 lastUsedModel 对应项）。

## 4. 前端组件（apps/web）

- `components/settings-modal.tsx`（新）：左右分栏弹窗，左侧导航（通用/模型/插件/Agent 预设/视觉工具/Web UI 插件/皮肤中心/宠物/社区插件），右侧内容区。本期只实现「模型」页，其余导航项占位。
- `components/provider-card.tsx`（新）：收起=名称+绿点+编辑；展开=表单（API 密钥占位「已配置——输入新值可替换」、自定义设置折叠、API 地址、获取可用模型、模型目录虚线提示、添加模型）+ 取消/保存。
- `components/custom-provider-modal.tsx`（新）：Provider ID / 显示名称 / API 地址 / API 协议(下拉 openai-completions/openai-responses/anthropic-messages) / API 密钥 / 模型目录行（模型 ID + 显示名称 + 删除）+ 添加模型 + 取消/创建提供方。
- `components/model-select.tsx`（改）：二级分组列表，组头灰字，选项含选中浅灰高亮，预选 `lastUsedModel`。
- `components/icons.tsx`（扩）：齿轮/数据库/滑块/网络等侧栏图标（内联 SVG，沿用现有线性风格）。
- 「打开配置文件」按钮：仅在 `GET /api/config/open-file` 返回非 hidden 时渲染。

## 5. 一次性迁移（operator 执行，不在代码）

见 ADR-0014 Migration 段。执行后验证：`resolveLlmConfig()` 能解析旧 provider+model 为 lastUsedModel；`.env` 未复制（沿用旧引用名）。

## 6. 验证清单

- [ ] core build + `test/config.mjs` 覆盖多提供方 + lastUsedModel + protocol 映射。
- [ ] Web `tsc` 全绿。
- [ ] 设置弹窗：列出内置+用户+自定义；编辑保存后 `.env` 写入、modelPromise 失效。
- [ ] 自定义提供方：非法 ID 拒存、与内置撞名拒存；创建后出现在列表。
- [ ] 获取可用模型：openai 两协议拉到填充；anthropic 禁用+提示。
- [ ] 模型选择器：按提供方分组、预选 lastUsedModel、切换后写 lastUsedModel。
- [ ] 打开配置文件：本机打开编辑器；非本机按钮隐藏。
- [ ] 旧 settings.json 一次性迁移成功、对话可跑。
