# 04 — 权限级别并入 `session.config.permissionLevel`（移除 level/set 事件 + scratch）

**What to build:** 权限级别从 `level/set` 事件 + `PERMISSION_SCRATCH_KEY` 迁移到 `session.config.permissionLevel` 覆盖值。`getPermissionLevel` 改读 `session.config.permissionLevel`（覆盖）?? `general.permissionLevel` ?? `workspace`；`applyPermissionLevel` 写配置而非事件/scratch；`restorePermissionLevel` / 恢复从配置文件加载。`level/set` 事件删除，`PERMISSION_SCRATCH_KEY` 卸任。**保留「level 变更 → 提示词重建」副作用**（重建触发归 shell，不塞进 config 纯函数）。web 权限胶囊与首条消息 pre-chosen 改走配置。接受取舍：级别变更离开 append-only 审计时间线（已记 ADR-0016）。

**Blocked by:** 01 — SessionConfig 存储；02 — general + 级联

**Status:** ready-for-agent

- [ ] `getPermissionLevel` 读 `session.config.permissionLevel`（覆盖）?? `general.permissionLevel` ?? `workspace`
- [ ] `applyPermissionLevel`/`restorePermissionLevel`/恢复写读配置文件而非 `level/set` 事件 / `PERMISSION_SCRATCH_KEY`
- [ ] `level/set` 事件删除；`PERMISSION_SCRATCH_KEY` 卸任
- [ ] level 变更保留提示词重建副作用（shell 触发）
- [ ] web 权限胶囊、首条消息 pre-chosen 写配置
- [ ] 验证：胶囊改级 → 配置文件持久化；新会话默认来自 `general.permissionLevel`；改级后提示词重建
