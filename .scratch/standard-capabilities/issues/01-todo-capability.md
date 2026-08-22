# 01: todo 能力 —— 状态类能力 tracer 弹

**What to build:** standard 会话中模型可经 todo 工具维护一份跨轮持久的任务清单（增删改查条目、勾选完成）；会话恢复后清单仍在。每轮扁平提示词的 capability 层实时渲染当前清单摘要，模型隔多轮不丢进度。这是状态类能力（memory 形态）的第一发 tracer 弹：验证「文件态 + 工具 + 实时片段」模式，后续 plan/goal 克隆它。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] todo 以 Capability 契约（`{ id, prompt(env, session), tools }`）注册进 extensions 包注册表；接线后 `enableBundleSpec` 对该声明 id 不再打 warn
- [x] 清单态落盘 project root 内 `.harness/todo.json`；写工具按级别自决——readonly 自拒、workspace/fullaccess 放行（文件按构造成立在 root 内，无需逐调用路径检查）；经 executeTool 级 ctx 测试
- [x] `assembleFlatPrompt` 输出含当前清单摘要片段（1-based 编号、`[ ]`/`[x]` 状态），位于 permissionFragment 之后、app/plugin 片段之前；清单为空时渲染 `(todo list is empty)` 空态行（稳定行为）
- [x] base bundle 的提示词与注册面完全不受影响（sibling 隔离）
- [x] 装配缝测试（bundle.mjs：landed 列表加 todo、unwired 列表移除 todo、drift guard 照跑）+ 行为测试（test/todo.mjs 18 项）全绿
