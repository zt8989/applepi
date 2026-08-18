# 02 — 本地扩展自动发现 + hello 工具

**What to build:** 往 `apps/agent/extensions/` 丢一个 `*.ext.ts`，无需改动任何加载器或 harness 代码，其声明的工具就被自动注册并可供模型调用。验证 loader 的目录扫描机制与 extension 的拉模式契约（`setup(api)` 中调 `api.register_tool(...)`）。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** ready-for-agent

- [ ] 一个定义 `hello` 工具的示例扩展被自动发现，模型可成功调用该工具
- [ ] 增加 / 删除扩展文件后，可用工具集合随之变化，且无需编辑 loader 代码
- [ ] 自动发现机制与 Q12/Q14 锁定的"本地 `extensions/` 目录扫描"一致（信任模型 = 本机自有代码）
