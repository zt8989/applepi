# 03 — Denylist 安全闭环

**What to build:** 当模型试图执行命中黑名单的 bash 命令时，最外层 `tool` 中间件否决该调用，结果以 `BLOCKED` 返回，模型拿不到任何执行结果。验证在 (iii) 级改写权限（中间件可改写工具参数）下，(b) denylist 安全层依然有效——因为 denylist 处于洋葱最外圈，能审到所有内层改写后的最终命令。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** resolved

- [x] 诱导模型执行黑名单命令（如 `rm -rf /`）时被否决，返回结果标记为 `BLOCKED`，且命令实际未执行
- [x] 内层具备 (iii) 改写权限的中间件无法绕过 denylist（因 denylist 在最外层、退出最晚）
- [x] denylist 默认名单与 Q16/(B) 决策一致：denylist 作为特权内置扩展，priority 最高、不可被其他 hook 覆盖

## Answer

- **denylist 改为 entry + exit 双检查**(`packages/core/src/extensions/denylist.ts`)：
  - ENTRY：模型发出的命令在任意执行前被审计，命中黑名单即 **veto**（不调 `next`），命令**永不执行**；
  - EXIT：内层中间件（含 (iii) 改写权限）改写后的**最终命令**被再审，命中则把 `ctx.toolResult` 覆盖为 `BLOCKED`——模型拿不到真实执行结果。
  - 这落实了规格 §7"最外层、退出最晚、审最终命令"，并**消解了 T01 代码审查的 Sp1 偏差**（原实现仅 entry 检查，内层改写可绕过）。
- **`runLoop` 增加 `llmCall` 注入缝**(`loop.ts`,`LoopOpts.llmCall`)：默认仍是 Vercel AI SDK `generateText`,可注入假 LLM 以**免 API key** 跑通完整闭环；生产路径行为不变。
- 验证：
  - `packages/core/test/smoke.mjs` 用例 9/10（纯 `node`）:用例 9=模型 `rm -rf <sentinel>` 被否决、返回 BLOCKED、sentinel 文件仍存在(命令未执行);用例 10=内层 (iii) 中间件把 `echo safe` 改写成 `rm -rf` 后,denylist EXIT 检查使其结果被覆盖为 BLOCKED(模型拿不到真实结果)。
  - `apps/agent/scripts/check-denylist.ts`(`pnpm --filter agent check-denylist`,tsx 免 key):在真实 Harness+洋葱总线+内置 loop 上下文复现上述闭环,输出 `BLOCKED by denylist: rm -rf ...` 且 sentinel 存活。
- 验证结果：`pnpm -r build` 全绿；smoke **10/10**；`check-denylist` 输出 OK。
- denylist 默认名单(8 条正则)与 Q16/(B) 一致,priority 1000 最外层、不可被其他 hook 覆盖。
