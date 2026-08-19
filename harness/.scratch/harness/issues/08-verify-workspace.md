# T08 — Workspace 构建与运行验证

**状态**: DONE
**依赖**: T01–T07（全部已提交）
**提交**: （待提交）

## 目标

把分散的验证脚本串成统一命令，跑通整个 pnpm workspace 的「安装 → 构建 → 测试 → 验证」链路，确认单机 agent 在真实 Harness + 洋葱总线 + 内置 loop 下可构建并以无 key 方式端到端运行。

## 改动

- `package.json`（根）：新增 `test`（`pnpm -r test`）与 `verify`（`pnpm -r build && pnpm -r test && pnpm --filter agent verify`）脚本。
- `apps/agent/package.json`：新增 `verify` 脚本，顺序串联 6 个无 key 检查：
  - `check-ext`（自动发现本地 extensions/ 并注册 hello 工具）
  - `check-denylist`（denylist 闭环：拦截 `rm -rf` 哨兵文件，命令从不真正执行）
  - `check-memory`（memory 扩展：写→持久化 JSON→读回）
  - `check-skills`（skills 扩展：skill_load 后系统提示注入）
  - `check-mcp`（mcp 扩展：mcp_call 通过 bash 桥接 `mcp-cli`，结果回灌会话）
  - `check-soft-isolation`（中间件抛错被总线逐层 try/catch 捕获，转为 ERROR 结果并继续 loop）

## 验证结果

- `pnpm -r build`：core / extensions / agent 三包 `tsc` 全通过（agent 产出 `dist/main.js` + `main.d.ts`）。
- `pnpm -r test`：
  - `@harness/core` smoke：11/11 通过。
  - `@harness/extensions`：memory / skills / mcp 各 7/7，共 21/21 通过。
- `pnpm --filter agent verify`：6 个检查全部 OK，无需真实 API key。

## 结论

T01–T07 的全部能力（事件总线、2 个内置工具、loader、内置 loop、denylist、memory/skills/mcp 参考扩展、软隔离）在统一工作流下构建通过且端到端可运行。T08 收尾，8 个工单全部完成。
