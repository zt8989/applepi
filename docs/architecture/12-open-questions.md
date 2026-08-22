# 12. 待确认项

> [11 仓库布局 ←](11-repo-layout.md) · [索引](../architecture.md)

1. `SessionContext` 字段（history / config / scratch）的精确结构。
2. ~~denylist 默认黑名单/白名单的具体内容~~ → 已由 ADR-0007 确认：denylist 8 条危险正则作为底线 + 权限级别白名单/路径规则。
3. 是否生成最小可运行脚手架（含 AI SDK 接入，需 API key）。