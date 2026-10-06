# event-loop-agent

## 介绍

用 **Redux Loop**（Elm Architecture 移植到 Redux 的那个库）写的一个 agent 内核：**没有 while 循环的
agent** —— 循环不是写出来的，是 reducer 与副作用互相 dispatch 出来的环。

三件事让它和一般的 agent 写法不一样：

- **执行历史是一棵树**，像 `git log` 一样，一次尝试一个节点。失败和超时也留在树上，
  重试就是一次分叉：新尝试的父 id 指向**超时前**的那个节点。
- **错误也持久化。** 错误节点和成功节点走同一条路落盘（追加写 JSONL，崩了只丢最后半行），
  所以「失败过」不会随着对话滚出屏幕而消失。
- **内核只有一份，跑在 Node 里。** 界面（pi-tui 终端）订阅它、画它、发消息给它，工具（`read` / `write` / `edit` /
  `bash`，直接用 Pi 官方那套）摸的是真实文件系统。

**本文只讲怎么装、怎么起、怎么测。** 它是什么、内部怎么转、接口有哪些见
[`docs/architecture.md`](docs/architecture.md)。文档分工：README 是入口，
`docs/architecture/` 是现状（对着代码核过，带快照 commit）。

## 前置准备

- **Node.js 20+**（pi-tui 要求 ≥22.19，实测 24.9 可用）
- **npm**
- 真实跑模型时需要对应 provider 的 API key

所有全局状态都在**配置家目录** `~/.pi/agent/` —— 与 pi 同址，两边共用同一份配置与历史。
可搬家：`REDUX_AGENT_DIR`（本项目优先）或 `PI_CODING_AGENT_DIR`（pi 的官方名）。

```text
~/.pi/agent/
  models.json            provider / 模型目录（pi 当前要求 models 是数组）
  auth.json              凭证
  settings.json          默认 provider / model
  sessions/
    --<cwd 编码>--/<id>.jsonl   会话（可恢复；pi 的 /resume 也能看到）
  traces/                        ← 只有本项目写，pi 没这个目录
    <id>.jsonl                  轨迹树 + 装载段（prompt / model）
```

**为什么与 pi 同址**：provider 目录改一次两边都得知道，key 改一次两边都得用。分两个目录的
代价是每次改配置要同步两次，收益仅仅是一个命名上的所有权标记。会话目录名（`--<cwd>--` 编码）
与 header 形状也照抄 pi，所以历史两边互通；`traces/` 是我们多出来的，单独放。

三个 json 手写或从别处拷进来。`models.json` 放 provider 的 baseUrl / api / 模型目录，
`auth.json` 只放凭证；`.env` 里的 `<ID>_API_KEY` 也能用（`npm start` 走
`--env-file-if-exists=.env`）。命令行的 `-P` / `-m` 仍然优先。

- `-P/--provider`：models.json 里自定义的 provider，或 pi 自带的 44 个内置 provider
  （`anthropic` / `openai` / `deepseek` / …）。凭证优先级：models.json > auth.json >
  `<ID>_API_KEY` 环境变量（与 pi 一致）。
- `models.json` 的形状：pi 要求 `models` 是**数组**。本项目两种都读，读到旧的对象 map
  会顺手把盘上那份改成数组 —— 否则 pi 自己读同一个文件时整个文件作废。

## 运行

```bash
npm install
```
**终端界面**（pi-tui）：

```bash
npm start                                  # 交互式
npm start -- -p "今天几号？"               # 跑一条就退出，顺带打印轨迹树
npm start -- --demo                        # 不打网络：pi-ai 自带的 faux provider
npm start -- --llm-timeout 30000 --attempts 3   # 短超时 + 三次尝试，好看到重试分叉
npm start -- --cwd ../other                # 工具的文件操作边界换到别的目录
```

界面里：`Ctrl+T` 切换轨迹面板，`Ctrl+C` 中断当前回合（空闲时退出）。

界面支持斜杠命令，在输入框里打 `/` 弹补全：

| 命令 | 作用 |
| --- | --- |
| `/sessions` | 弹窗选一个历史会话恢复。**零 token** —— 不重跑模型，只把消息读回来 |
| `/new` | 开**新会话**：换 id → 换文件。上一段完整留在 `sessions/` 里 |
| `/clean`（或 `/wipe`） | **删除**除当前会话外的全部历史会话（连同轨迹文件）。不可逆 |
| `/help` | 命令列表 |

命令**不发给模型** —— 那是给界面/内核的管理动作。

选项：`-p/--print`、`-P/--provider`、`-m/--model`、`-s/--system`、`--max-turns`、
`--llm-timeout`、`--attempts`、`--api-key`、`--demo`、`--no-trace`、`--session`、
`--cwd`、`--trace-dir`、`-h/--help`。

配置/provider 这一层**直接用 pi-coding-agent 的 `ModelRuntime`**（它自己读 models.json /
auth.json、做 schema 校验、拼凭证优先级，并自带 44 个内置 provider、1500+ 模型目录）。
详见 [`docs/architecture/provider.md`](docs/architecture/provider.md)。

## 测试

```bash
npm test           # 111 个离线测试，不打网络
npm run typecheck  # tsc --noEmit（src + test）
```

全程离线（pi-ai 的 faux provider），不消耗 token。覆盖：环闭合、轮数上限、错误路径、
reducer 纯性、轨迹树的不变量（**超时后重试的父 id 指向超时前的节点**）、错误落盘与 JSONL
回放、会话清理、真实文件 IO。

## 目录

```
src/                    内核 + pi-tui 界面（见 docs/architecture.md）
test/                   离线测试
docs/architecture/      架构现状
~/.pi/agent/       运行时状态：配置 / 会话 / 轨迹（与 pi 共用，不在仓库里）
scripts/           配置迁移（migrate-config-dir / migrate-models）
```
