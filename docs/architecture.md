# 架构现状

这套文档记录 event-loop-agent **今天是什么样**，而不是它曾经是什么样、或打算成为什么样。
每条陈述都对着代码核过；快照点写在下面，与它对不上的地方以代码为准。

**快照：`80a8733`（2026-10-05）。** 那一提交是「README 只留简介与启动/测试，架构现状搬进
`docs/architecture/`」—— 它给本目录建立了七篇的骨架。骨架之上的工作树改动（prompt / model
两块状态、洋葱式 middleware、装载段落盘与零 token 回放）见 [init](architecture/init.md)；
会话文件与「恢复历史」见 [sessions](architecture/sessions.md)。

再往前：`4f535fb`（内核搬到 Node，界面与内核共享同一份环；工具走真实文件系统）给了
[kernel](architecture/kernel.md) 与 [surfaces](architecture/surfaces.md) 整篇；`2ea9113`（工具换成
pi-coding-agent 的官方实现，pi-ai 升到 1.0.2）给了 [tools](architecture/tools.md) 全部；
`2b7053a`（引入轨迹树与 pi-tui）给了 [trace](architecture/trace.md) 与 [loop](architecture/loop.md)。

## 与别处的分工

| 地方 | 是什么 |
| --- | --- |
| `README.md` | 怎么装、怎么起、怎么测 |
| **`docs/architecture/`（本目录）** | **现状的骨架**：模块地图、环怎么转、状态存在哪、接口有哪些 |
| 代码注释 | 为什么这么写。取舍与踩坑留在写它的地方，不搬到这里 |

边界是刻意的：**现状只有一个地方。** 改行为时要看是否动到了本目录（那是现状），
其余细节去代码里看（那是为什么）。

## 边界与已知不对齐

- **工具没有沙箱。** `--cwd` 只限制**路径边界**（官方工具自带的检查），不阻止 `bash` 跑任意命令。
  内核跑在 Node 上，以启动它的那个用户的权限行事。
- **`llm.giveup` 是死代码**：类型与 transition 都在，但没有任何地方 dispatch 它。重试用尽时
  `llm.failed` 直接把相位推到 `idle` 就够了。见 [loop](architecture/loop.md)。

## 文档目录

| 文档 | 讲什么 |
| --- | --- |
| [overview](architecture/overview.md) | 三条铁律、进程与端口、一次消息的路径 |
| [loop](architecture/loop.md) | 环怎么转：action、transitions 表、接线表、超时与重试 |
| [trace](architecture/trace.md) | 轨迹树：节点模型、tip 规则、渲染、落盘与回放 |
| [kernel](architecture/kernel.md) | 内核装配：一个 store，界面共享它 |
| [tools](architecture/tools.md) | 工具来自 pi-coding-agent，那层适配做了什么 |
| [provider](architecture/provider.md) | 配置从哪来：复用 pi 的 ModelRuntime，内置 provider 目录 |
| [surfaces](architecture/surfaces.md) | TUI 渲染层，以及它踩过的坑 |
| [init](architecture/init.md) | 装载：prompt / model 两块、模型能力、中途插 prompt、洋葱式 middleware、零 token 回放 |
| [sessions](architecture/sessions.md) | 配置家目录、会话文件格式、恢复历史（零 token） |
