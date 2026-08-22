# 03: chat / approve 迁入服务端（流式核心）

**What to build:** `/api/chat` 与 `/api/chat/approve` 迁入服务端：`runLoopStreamSegment` + 暂停/恢复状态机全链路（含 approve-with-payload 的 `answer` 透传、next-pending 的 expectsAnswer 解析）；`streamTextCall` 注入缝存在供测试。假 LLM 请求级测试：流式段、ask 暂停、载荷续跑、deny、多 pending 队列。线格式与请求/响应契约不变。

**Blocked by:** 01（server 骨架）。

**Status:** ready-for-agent

- [ ] `/api/chat` 迁入：首条消息建会话（level/reasoning/mode pre-chosen）、流式段（data-stream 线格式）、ask 暂停持久化 pending
- [ ] `/api/chat/approve` 迁入：approve/deny/answer 透传、next-pending 队列、续跑不重跑 LLM
- [ ] `streamTextCall` 注入缝可用（测试传 fake streamText，不触真实提供方）
- [ ] 假 LLM 请求级测试：流式文本、工具暂停与事件持久化、approve-with-payload 结果=答案、deny 回填、多 pending 顺序
- [ ] `pnpm -r verify` 绿