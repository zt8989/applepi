# 7. 安全模型（Permission Levels, ADR-0007 + ADR-0009）

> [06 工具映射 ←](06-tools-ai-sdk.md) · [索引](../architecture.md) · [08 会话持久化 →](08-session-persistence.md)

- **权限级别系统**：`readonly` / `workspace` / `fullaccess`，会话级单一主级别，统一作用于所有工具。
  每个级别由「可读 × 可写」两维构成——读一律全盘，写范围分级（readonly 不可写；workspace 仅限
  project root=cwd realpath 内；fullaccess 任意）。
- **工具自决（ADR-0009）**：core 内置 SecurityPolicy（默认实现），无运行时拦截中间件；
  每个工具 execute 读 `ctx` 中的 level 自行约束行为（bash 只读白名单、sre view-only 等）。
- **denylist 底线**：原 8 条危险正则作为**任何级别下都生效的绝对底线**，内嵌于 bash 工具自身
  （`fullaccess` 也不允许 `rm -rf`、fork bomb 等）。
- **提示词携带级别（ADR-0015 最终形态，deepen #01 修订）**：权限**声明段**由
  `@applepi/bundle` 的共享 `permissionFragment` 承载（base/standard 共用同一渲染器，
  由 `resolvedTools` 实时生成「Tools available」清单，按当前级别分档）——不再逐 bundle
  手写、不再向模型声称未接线能力；app 每轮把它并入扁平提示词；core 的 `security`
  只保留强制机制，不再写任何提示词文案。级别变化是普通状态记录，不触发提示词重建
  ——下一轮拼接自然带上新级别。
- **级别持久化（ADR-0016）**：级别存 `session.config.permissionLevel` —— 会话覆盖写
  `<id>.config.json>`（`applyPermissionLevel`），全局默认读 `settings.json.general.permissionLevel`，
  生效值 = 覆盖 ?? 全局 ?? `workspace`（`resolvePermissionLevel` 级联，恢复后写回内存
  `session.config`）。
- **只有用户能改级别**：`/level <readonly|workspace|fullaccess>` 是用户驱动的 slash 命令
  （`registerSlashCommand` 扩展点），模型没有改级别工具（防自我提权）。
- **信任边界**：extension 同进程 = 等价授信；权限系统防的是**模型自主用工具犯错**，不是防扩展。