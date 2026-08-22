# 05: grill —— web 能力设计（批次二设计闸门）

**What to build:** 对 web 能力做一轮 /grill-with-docs 定案。议题：web_search 后端选型（外部搜索 API 的选择与账号/配额）及其密钥存放位（settings.json providers 体系之外的新密钥位怎么定）；web_fetch 的正文提取策略（html→text、大小上限、超时、重定向）；两工具的 approval 分类（读类 auto 还是 fetch 也 ask）与权限级别语义（readonly 下联网读是否放行、project root 约束是否适用）；无网络/密钥缺失时的失败语义。

**Blocked by:** None (can start immediately).

**Type:** grilling

**Status:** ready-for-agent

- [ ] 每个议题有决策 + 理由，记入 CONTEXT.md（必要时 ADR）
- [ ] 产出 web 实施票清单（后续拆），含验收口径
