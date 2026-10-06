# Provider 装配

配置从哪来、provider 和模型怎么解析出来、凭证从哪读。

## 主路径：pi-coding-agent 的 `ModelRuntime`

`src/pi-config.ts` 导出的 `createPiModelRuntime()` 是主装配路径。它就是 pi 自己用的那套：

```ts
const runtime = await ModelRuntime.create();   // 读 ~/.pi/agent/{models,auth}.json
runtime.getModel('workbuddy', 'cn:space-bunny');
await runtime.getAuth(model);                   // models.json > auth.json > <ID>_API_KEY
runtime.streamSimple(model, context);          // api 名 → 协议映射也是它做的
```

`ModelRuntime` 从 pi-coding-agent 的**主入口**导出（子路径被 `exports` 封了，只能这么引）。

### 换来了什么

| | 手写时 | 用 `ModelRuntime` |
| --- | --- | --- |
| 内置 provider | 3 个（手列） | **44 个** |
| 内置模型目录 | 无（只有 models.json 里自定义的） | **1500+**（baseUrl / 协议 / 价目表齐全） |
| models.json 校验 | 自己写一层 | TypeBox schema，报错指到具体 provider 的字段 |
| 凭证优先级 | 自己拼（models.json → auth.json → env） | 官方实现，含 OAuth 与 `source` |
| api → streamSimple | 自己 switch 三个 | 全部协议（responses / anthropic-messages / …） |

那些内置模型目录是**手抄不出来**的 —— 每个 provider 的 baseUrl、协议细节、价目表都会随
上游变。交给 pi 的实现，我们就不会过期。

### 代价：启动慢 ~2.4s

`import` 整个 pi-coding-agent 要 ~2.6s（它把 TUI、终端组件一起拉进来），比手写装配的
~0.2s 慢。`ModelRuntime.create()` 又 ~0.8s。对一个交互式 CLI 可以接受。

为此 `createPiModelRuntime()` 用**动态 import** —— 测试走手写路径时不会付这个代价。

## 手写路径还在（不是漏删的旧代码）

`createModelsWithPiConfig()` + `buildProvider()` + `normalizeModels()`，两个用途：

1. **离线测试**：要一个不碰网络、不依赖真实家目录的 `Models`。`ModelRuntime.create()`
   会读真实 `~/.pi/agent`（测试虽然隔离了家目录，但那样就没有 provider 了）。
2. **降级**：`ModelRuntime.create()` 失败时（配置坏到连它都起不来、版本不兼容）退回
   手写装配，至少还能用 models.json 里的自定义 provider，而不是整个起不来。降级信息
   写 stderr。

`createRuntime()`（`src/provider.ts`）就是这两个之间的选择点。

## models.json 的两种形状

pi 现在要求 `models` 是**数组**，旧版（本项目早期写的）是**对象 map**：

```json
"models": [ { "id": "…", "contextWindow": 1000000 } ]            ← 现在
"models": { "some-id": { "id": "…", "contextWindow": 1000000 } }  ← 旧
```

`ModelRuntime` 只认数组。手写路径与 `normalizeModels()` 负责归一（数组原样、对象 map
展平，map 的 key 当 id 兜底），并在读时顺手把盘上那份改成数组 ——
**否则 pi 自己读同一个文件时整个文件作废**（一个 provider 都不装，不是某一个失败）。

## 配置家目录

默认 `~/.pi/agent`，与 pi 同址。环境变量 `REDUX_AGENT_DIR`（本项目，优先）>
`PI_CODING_AGENT_DIR`（pi 官方名）。比 pi 多认前一个，是为了让测试能把自己从真实家目录里
摘出去。详见 [sessions](sessions.md)。

## 相关

- 内核装配 → [kernel](kernel.md)
- 环怎么转 → [loop](loop.md)