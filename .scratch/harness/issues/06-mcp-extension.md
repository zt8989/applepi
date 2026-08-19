# 06 — MCP 参考扩展（bash + mcp-cli 桥）

**What to build:** 提供 `mcp_call` 工具，经 bash 执行 `mcp-cli <server> <tool> <args>` 来打通外部 MCP server。验证 Q8 决策：mcp 不建专用子进程桥，直接退化为"bash 里跑一条 mcp-cli 命令"，与"核心只有 bash + editor"哲学自洽。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** done

- [ ] 在本机存在 `mcp-cli` 的前提下，`mcp_call` 能触达某个外部 MCP server 并通过 bash 桥返回其输出
- [ ] 这是一个 thin slice（端到端打通即可），明确依赖本机已安装 `mcp-cli`
- [ ] 不引入独立于 bash 的 MCP 子进程连接逻辑（遵循 Q8/(A) 与 Q16 的极简核心边界）
