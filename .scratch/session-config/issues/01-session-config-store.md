# 01 — SessionConfig 类型 + `<id>.config.json>` 存储 + 身份持久化

**What to build:** 会话配置（`session.config`）成为可持久化、可恢复的统一载体。core `session` 模块新增 `SessionConfig` 类型（可选字段 `workspace` / `mode` / `model` / `reasoningLevel` / `permissionLevel`）与 `SessionStore` 的一对读写方法：`loadConfig()` 读旁挂 `<session_id>.config.json>`（缺失/损坏 → `{}`，**不 fail fast**，因为它不是必需配置），`saveConfig(config)` 对同一文件做**原子全量重写**（tmp+rename）。此前 `mode` 依赖一个 stopgap `mode` 事件——本票把它**迁进 `session.config.mode`**（落盘，resume 从配置文件恢复，兑现 ADR-0015「mode 恢复重建 spec」）；`workspace` 存身份位（绝对值，自包含恢复、不依赖 manifest 查询）。web 的 `bindSession` / resume 流程改走此存储：新建会话写入身份一次，恢复时 `loadConfig()` 填充内存中的 `session.config`。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] core `session` 模块存在 `SessionConfig` 类型导出与 `loadConfig`/`saveConfig`（原子写、缺失→`{}`）
- [ ] `mode` 不再依赖 stopgap `mode` 事件：新建写 `session.config.mode` 落盘，resume 从配置文件恢复
- [ ] `workspace` 作为身份字段持久化（绝对值），恢复自包含
- [ ] web `bindSession`/resume 改走该存储；新建会话后 `<id>.config.json>` 含身份，resume 从文件恢复而非事件
- [ ] core 测试覆盖：write→read round-trip、缺失→`{}`、恢复身份正确
