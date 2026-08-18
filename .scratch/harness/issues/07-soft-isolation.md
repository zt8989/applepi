# 07 — 软隔离（misbehaving middleware）

**What to build:** 当 `tool` 栈中某个中间件抛异常时，异常被逐层 `try/catch` 兜住，转化为 `ERROR` 结果返回给模型，而不是拖垮整个 agent loop。验证 Q7/(iii) 权力等级下、同进程零隔离前提中的"软隔离"兜底（§4）。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** ready-for-agent

- [ ] 一个故意抛错的中间件产生 `ERROR` 结果交付给模型
- [ ] agent loop 在出错后仍能继续后续轮次，不崩溃
- [ ] 软隔离逻辑位于洋葱总线的层递归 `try/catch` 中（T01 已埋骨架）
