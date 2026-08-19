# 04 — Memory 参考扩展

**What to build:** 提供 `memory_read` / `memory_write` 工具，把键值对持久化到本地 JSON 文件，并在同一会话内可回读。验证 extension 通过 `register_tool` 扩展 `tool` 栈、并通过 `ctx` 读写会话/本地状态的能力。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** done

- [x] `memory_write` 写入一个值后，后续同一会话内的 `memory_read` 能取回该值（scratch mirror）
- [x] 持久化落盘到本地 JSON 文件，跨工具调用不丢（文件后端）
- [x] 作为 `@harness/extensions` 内的参考扩展之一，接口与 Q8/(A) 一致（同进程注册，无需子进程桥）
