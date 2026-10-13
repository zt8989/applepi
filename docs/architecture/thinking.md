# 思考级别（reasoning effort）

`state.model.thinkingLevel` 是**请求参数**（reasoning effort），不是输出格式 ——
设了 `high` 不代表模型一定回馈 thinking，很多模型直接不给（见 [init](init.md) 的 thinking 一节）。

它的规则**逐条照抄 pi**：唯一入口是 `src/thinking-level.ts`，启动解析在 `src/kernel.ts`
的装配段，落盘走 `settings.json` 里 pi 的同名键，会话里走 `thinking_level_change` 条目。
「本地那份表」和「pi 那份表」一旦分家，症状是同一个会话在两边恢复出来的档位不一样 ——
所以下面每条都标了 pi 的出处。

## 一、五条来源的优先级（启动时）

| 顺序 | 来源 | 谁写它 |
| --- | --- | --- |
| 1 | 命令行 `--thinking` | 用户，一次性 |
| 2 | 会话文件里最后一条 `thinking_level_change` | 恢复/续聊的那个会话 |
| 3 | `settings.json` 的 `defaultThinkingLevel` —— **仅当「会话存在但没有那条记录」** | `/thinking` 面板的 `Ctrl+S` |
| 4 | `settings.json` 的 `modelThinkingLevels["provider/id"]` | pi 的 `/settings`（本项目只读这半边） |
| 5 | 内置 `medium` | pi 的 `core/defaults.js` |

对应 pi 的 `core/sdk.js:120-142`。两处要留意：

- **第 3 步会短路**：会话存在（`messages.length > 0`）但没有那条记录时，pi 直接给
  `defaultThinkingLevel ?? medium`，于是第 4 步的 per-model 覆盖**看不到**。这是 pi 的实际
  行为，照抄；改了它，症状是「同一个老会话在 pi 与本项目里恢复出来的档位不一样」。
- **空壳文件不算已有会话**（`messages.length` 为 0），走「新会话」那条路。

解析完还要过一遍 clamp（见下）。命令行给了也 clamp —— pi 的 `--thinking` 文档就写着
「clamps to the model's capabilities」。

## 二、clamp：默认 medium 为什么会变成 high

判据是模型的 `thinkingLevelMap`：映射成 `null` 的档位**不支持**，**没写这个键的档位默认支持**
（`xhigh` / `max` 例外，必须显式映射）。clamp 是「从当前档位**往上**找第一个支持的；找不到再
往下」。

以 `qwen-token-plan-cn/deepseek-v4.1-flash` 为例（两者都在这台机器的
`~/.pi/agent/models-store.json` 里）：

```json
{ "off": null, "minimal": null, "low": "low", "medium": null,
  "high": "high", "xhigh": null, "max": "max" }
```

支持集 = `low` / `high` / `max`，于是：

| 请求的档位 | 实际生效 | 为什么 |
| --- | --- | --- |
| `medium`（内置默认） | `high` | medium 不支持 → 往上第一个是 high |
| `off` / `minimal` | `low` | 都不支持 → 往上第一个是 low |
| `xhigh` | `max` | xhigh 不支持 → 往上第一个是 max |

**「pi 在这个模型上默认就是 high」= 内置默认 medium + 这张表 + 向上取整**，不是 pi 把默认
写成了 high。这个模型上 `off` 也**不存在**（它被显式标成不支持）—— 也就是说**关不掉思考**。

clamp 用的是 pi-ai 导出的 `clampThinkingLevel`（`clampForModel` 只是它的一层壳，附上
「没模型 → `off`」，与 pi 的 `if (!model) thinkingLevel = "off"` 同一句）。

## 三、什么时候会变，变了写哪儿

| 入口 | 换档位 | 写 `settings.json` | 写会话文件 |
| --- | --- | --- | --- |
| `Shift+Tab`（pi 的 `app.thinking.cycle`） | ✅ 只在模型支持的档位上循环 | ❌ | ✅ |
| `/thinking` 面板回车 | ✅ | ❌ | ✅ |
| `/thinking` 面板 **`Ctrl+S`** | ✅ | ✅ `defaultThinkingLevel`（落的是**请求值**，不 clamp） | ✅ |
| `/thinking <级别>` | ✅（大小写不敏感；不命中就报可选值，与 pi 同文案） | ❌ | ✅ |
| `/settings` 里的 **Default thinking level per model** | ✅（per-model 覆盖；改的正好是当前模型时当场生效） | ✅ `modelThinkingLevels` | ✅ |
| `--thinking <级别>` | ✅（不认的值**告警并忽略**，不退出） | ❌ | — |
| `-m id:<级别>`（模型 pattern 的 `:<thinking>` 后缀） | ✅（**低于** `--thinking`，与参数顺序无关） | ❌ | — |
| 换模型（`/model`、`Ctrl+P`、恢复会话） | ✅ 重新解析 | ❌ | ✅ |

写会话文件的**唯一**地方是会话记录器（`src/session-recorder.ts`）：它是 store 的订阅器，
`state.model.thinkingLevel` 一变就追加一条 `thinking_level_change`。四个入口都走同一条路 ——
在各处各写一遍必然会漏一个，而漏掉的那个的症状是「换了档位、恢复时又变回去了」。

`Ctrl+S` 落的是**请求的档位**（pi 的 `setDefaultThinkingLevel(level)` 传的就是原值）。所以在
`deepseek-v4.1-flash` 上「存 medium」等于「存 high」；而**不**在写之前 clamp 是刻意的：
那样用户以为存的是 medium、盘上却是 high，换个模型再换回来就永久改了。

## 四、换模型：pi 的 `_getThinkingLevelForModelSwitch`

作用域条目写死的档位（`/scoped-models` 的 `p/id:high`）→ per-model 覆盖 → 全局默认 →
**当前那一档**（pi 的 `?? this.thinkingLevel`），然后 clamp。三样都没配时它**等价于「级别带着
走」**（所以默认配置下与早先的行为一样）；配过时才分得出来，而分不出来就成了
「pi 换过去是 high、本项目换过去还是旧的 low」。

## 五、会话往返

| 时机 | 写什么 |
| --- | --- |
| 新会话第一次写文件（第一条消息） | 一条初始档位（pi 在会话建立时就写，见 `core/sdk.js:279-290`） |
| 档位真的变了 | 追加一条 |
| 恢复的老会话缺这一条 | 回填一条 |
| 恢复一个**有**这一条的会话 | 把它的档位带回 `state`（仍要 clamp 到**当前**模型的能力） |

**与 pi 有一处刻意的时间差**：pi 的会话文件从建立那一刻就存在，所以它的回填是「恢复时立刻
写」；本项目是「空会话不落盘」（见 [sessions](sessions.md)），回填推迟到**真的要写文件时**。
后果只有一个：恢复一个老会话又直接退出，盘上不会多这一行。换来的是那条硬挣来的不变式：
**恢复不写盘**（`test/restore-perf.test.ts`「会话文件一个字节都不该变」）。

## 六、思考预算（`thinkingBudgets`）

思考与正文共用同一个 `max_tokens`，所以一轮重度思考可能把整个回复吃光、正文一个字都不出。
`settings.json` 的 `thinkingBudgets` 就是给每一档定一个 token 上限：

```json
{ "thinkingBudgets": { "low": 512, "high": 4096 } }
```

四个键（`minimal` / `low` / `medium` / `high`）就是 pi 的全部 —— `xhigh` / `max` 在取预算时
会被归成 `high`（pi-ai 的 `clampReasoning`），所以没有它们的位置。与 pi 同一步：**开局读一次**
（`core/sdk.js:275` 递给 Agent 的那个字段），之后每个请求原样带上；聊到一半手改 settings.json
不生效（要重启），两边一样。

它只在**按 token 算预算**的端点上真的发出去：Anthropic / Bedrock 拿它当
`thinking.budget_tokens`，而 OpenAI 兼容端点要看模型目录里的 `compat.thinkingTokenBudgetField`
（`thinking_token_budget` = vLLM、`thinking_budget` = Qwen/DashScope/SGLang、
`thinking_budget_tokens` = llama.cpp；默认不开，也不在生成的目录里）。不配时 pi-ai 用它的
内置预算（minimal 1k … high 16k）。

**没有对应的设置行**（pi 也没有）：它属于「手改 settings.json」的那类旋钮。

## 七、代码位置

| 做什么 | 在哪 |
| --- | --- |
| 解析 / clamp / 换模型 / settings 读写 | `src/thinking-level.ts`（唯一入口） |
| 启动时装配那一档 | `src/kernel.ts` 的 `createKernel`（注释里逐步对着 pi 的 `sdk.js`） |
| 恢复会话时带回来 | `src/kernel.ts` 的 `restoreSession` |
| 落盘 + 回填 | `src/session-recorder.ts` |
| 读会话里那条 | `src/session-file.ts` 的 `sessionThinking` / `readSessionThinking` |
| 思考预算 | `readThinkingBudgets`（`thinking-level.ts`）→ `createKernel` → `store.ts` → `effects.ts` 的 `streamOptions.thinkingBudgets` |
| 循环（`Shift+Tab`） | `src/tui/pi-actions.ts` 的 `nextThinkingLevel`（`-1 → 第 1 个`，与 pi 的 `cycleThinkingLevel` 同式子；**与模型循环的 `-1 → 第 2 个`不同**） |
| 面板 | `src/tui/thinking-picker.ts`（pi 官方的 `ThinkingSelectorComponent`） |
| 设置面板（per-model 覆盖） | `src/tui/settings-picker.ts`（pi 的 `SettingsList` + `SteppedSubmenu`）；见 [settings](settings.md) |
| 命令接线 | `src/tui/app.ts` 的 `case 'thinking'` |