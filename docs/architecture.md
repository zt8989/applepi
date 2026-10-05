# 架构现状

这套文档记录 event-loop-agent **今天是什么样**，而不是它曾经是什么样、或打算成为什么样。
每条陈述都对着代码核过；快照点写在下面，与它对不上的地方以代码为准。

**快照：`4f535fb`（2026-10-05）。** 那一提交是「内核搬到 Node，TUI 与 Web 共享同一份环；
工具走真实文件系统」——它给本目录添的是 [kernel](architecture/kernel.md) 整篇、
[tools](architecture/tools.md) 的全部，以及 [loop](architecture/loop.md) 里「接线的几处绕圈」
与 [surfaces](architecture/surfaces.md) 整篇。上一版结构对应 `2ea9113`（工具换成 pi-coding-agent
的官方实现，pi-ai 升到 1.0.2），那之前是 `2b7053a`（引入轨迹树与 pi-tui，删掉 CLI 与 pi-agent-core）。

## 与别处的分工

| 地方 | 是什么 |
| --- | --- |
| `README.md` | 怎么装、怎么起、怎么测 |
| **`docs/architecture/`（本目录）** | **现状的骨架**：模块地图、环怎么转、状态存在哪、接口有哪些 |
| 代码注释 | 为什么这么写。取舍与踩坑留在写它的地方，不搬到这里 |

边界是刻意的：**现状只有一个地方。** 改行为时要看是否动到了本目录（那是现状），
边界是刻意的：**现状只有一个地方。** 改行为时要看是否动到了本目录（那是现状），
其余细节去代码里看（那是为什么）。

## 边界与已知不对齐

- **pi-web-ui 最高只到 `0.75.3`，没有 1.x**（其余 `@earendil-works` 包都到 1.0.2）。它自带一份嵌套的
  `pi-ai@0.75.5`，而根目录是 `1.0.2` —— 两份 `pi-ai` 并存。`web/src/main.ts` 里有两处 `as never`
  跨过了这个边界（`Context` / `Model` 结构相同、只是类型声明分家）。这是**碰巧兼容**不是设计上兼容，
  pi-web-ui 发 1.x 时该换掉。
- **工具没有沙箱。** `--cwd` 只限制**路径边界**（官方工具自带的检查），不阻止 `bash` 跑任意命令。
  内核跑在 Node 上，以启动它的那个用户的权限行事。
- **Web 侧没接会话持久化。** `SessionsStore` 只是在 `AppStorage` 构造函数里占位（pi-web-ui 强制要四个
  store），顶栏的「新对话」是清空内核，不落盘。真正的历史在 `.trace/<id>.jsonl`。
- **`llm.giveup` 是死代码**：类型与 transition 都在，但没有任何地方 dispatch 它。重试用尽时
  `llm.failed` 直接把相位推到 `idle` 就够了。见 [loop](architecture/loop.md)。
- **`npm run web`（只开 vite）时页面连不上内核** —— 它只是前端开发服务器，API 在 5273 那边。

## 系统一句话

一个 Redux Loop 写的 agent 内核，跑在 Node 里：**一个 store、一份环**，TUI（pi-tui）和
Web（pi-web-ui 组件 + 浏览器）是它的两个渲染层。执行历史是一棵一次尝试一节点的树，
错误与成功同样入树并落盘。

## 文档目录

| 文档 | 讲什么 |
| --- | --- |
| [overview](architecture/overview.md) | 三条铁律、进程与端口、一次请求的路径 |
| [loop](architecture/loop.md) | 环怎么转：action、transitions 表、接线表、超时与重试 |
| [trace](architecture/trace.md) | 轨迹树：节点模型、tip 规则、渲染、落盘与回放 |
| [kernel](architecture/kernel.md) | 内核装配：一个 store、两个界面共享它 |
| [tools](architecture/tools.md) | 工具来自 pi-coding-agent，那层适配做了什么 |
| [surfaces](architecture/surfaces.md) | TUI 与 Web 各自的渲染层，以及它们各自踩过的坑 |
