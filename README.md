# event-loop-agent

## 介绍

用 **Redux Loop**（Elm Architecture 移植到 Redux 的那个库）写的一个 agent 内核：**没有 while 循环的
agent** —— 循环不是写出来的，是 reducer 与副作用互相 dispatch 出来的环。

三件事让它和一般的 agent 写法不一样：

- **执行历史是一棵树**，像 `git log` 一样，一次尝试一个节点。失败和超时也留在树上，
  重试就是一次分叉：新尝试的父 id 指向**超时前**的那个节点。
- **错误也持久化。** 错误节点和成功节点走同一条路落盘（追加写 JSONL，崩了只丢最后半行），
  所以「失败过」不会随着对话滚出屏幕而消失。
- **内核只有一份，跑在 Node 里。** TUI 和 Web 是它的两个渲染层，工具（`read` / `write` / `edit` /
  `bash`，直接用 Pi 官方那套）摸的是真实文件系统。

**本文只讲怎么装、怎么起、怎么测。** 它是什么、内部怎么转、接口有哪些见
[`docs/architecture.md`](docs/architecture.md)。文档分工：README 是入口，
`docs/architecture/` 是现状（对着代码核过，带快照 commit）。

## 前置准备

- **Node.js 20+**（pi-tui 要求 ≥22.19，实测 24.9 可用）
- **npm**
- 真实跑模型时需要对应 provider 的 API key（默认 DeepSeek，读 `.env`）

## 运行

```bash
npm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
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

选项：`-p/--print`、`-P/--provider`、`-m/--model`、`-s/--system`、`--max-turns`、
`--llm-timeout`、`--attempts`、`--api-key`、`--demo`、`--no-trace`、`--session`、
`--cwd`、`--trace-dir`、`-h/--help`。

**网页界面**（同一个内核，浏览器只当渲染层）：

```bash
npm run web:serve                  # 构建前端 + 起内核 → http://localhost:5273
npm run serve                      # 只起内核（前端已构建过）
npm run serve -- --demo            # 离线 demo，不用 key
npm run serve -- --cwd D:/proj     # 工具的文件操作边界
npm run web                        # 只开 vite（前端热更新；此时没有内核，页面连不上）
```

**只起内核、页面发构建产物**（一个进程、一个地址）：

```bash
npm run web:build                  # 产出 web/dist
npm run serve                      # http://localhost:5273 既是页面也是 API
```

- 页面默认取 `<cwd>/web/dist`；`--cwd` 换目录时也跟着换。
- 没有 `index.html` 就只服务 `/api`（`GET /` 的 404 会写明该先跑什么命令）。
- 开发时分开起：`npm run serve -- --port 0` 起内核（启动横幅打印真正绑到的端口），
  另开终端 `npm run web` 连过去。

## 测试

```bash
npm test           # 36 个离线测试，不打网络
npm run typecheck  # tsc --noEmit（src + test）+ tsc --noEmit -p web
```

全程离线（pi-ai 的 faux provider），不消耗 token。覆盖：环闭合、轮数上限、错误路径、
reducer 纯性、轨迹树的不变量（**超时后重试的父 id 指向超时前的节点**）、错误落盘与 JSONL
回放、SSE 推状态、409 防双跑、真实文件 IO、目录穿越防护。

## 目录

```
src/                    内核（见 docs/architecture.md）
web/                    浏览器渲染层
test/                   离线测试
docs/architecture/      架构现状
.trace/                 运行时生成的轨迹 JSONL（已 gitignore）
```
