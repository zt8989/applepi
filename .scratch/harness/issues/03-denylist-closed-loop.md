# 03 — Denylist 安全闭环

**What to build:** 当模型试图执行命中黑名单的 bash 命令时，最外层 `tool` 中间件否决该调用，结果以 `BLOCKED` 返回，模型拿不到任何执行结果。验证在 (iii) 级改写权限（中间件可改写工具参数）下，(b) denylist 安全层依然有效——因为 denylist 处于洋葱最外圈，能审到所有内层改写后的最终命令。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** ready-for-agent

- [ ] 诱导模型执行黑名单命令（如 `rm -rf /`）时被否决，返回结果标记为 `BLOCKED`，且命令实际未执行
- [ ] 内层具备 (iii) 改写权限的中间件无法绕过 denylist（因 denylist 在最外层、退出最晚）
- [ ] denylist 默认名单与 Q16/(B) 决策一致：denylist 作为特权内置扩展，priority 最高、不可被其他 hook 覆盖
