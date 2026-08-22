# 03: chat / approve 迁入服务端（流式核心）

**What to build:** `/api/chat` 与 `/api/chat/approve` 迁入服务端：`runLoopStreamSegment` + 暂停/恢复状态机全链路（含 approve-with-payload 的 `answer` 透传、next-pending 的 expectsAnswer 解析）；`streamTextCall` 注入缝存在供测试。假 LLM 请求级测试：流式段、ask 暂停、载荷续跑、deny、多 pending 队列。线格式与请求/响应契约不变。

**Blocked by:** 01（server 骨架）。

**Status:** resolved

- [x] `/api/chat` 迁入：首条消息建会话（level/reasoning/mode pre-chosen）、流式段（data-stream 线格式不变）、ask 暂停持久化 pending；`sessionReasoningLevel` 对空/畸形 provider 注册表容错（回落默认档，健康配置行为不变）
- [x] `/api/chat/approve` 迁入：approve/deny/answer 透传、next-pending 队列（expectsAnswer）、续跑不重跑 LLM
- [x] `ChatSeam` 注入缝（model + streamTextCall，类型从 core `StreamLoopOpts` 派生避 pnpm 双副本 TS2719）；生产路径不传 seam 走真实解析
- [x] 假 LLM 请求级测试（chat-api.mjs 7 项）：流式文本、ask_user 暂停（expectsAnswer part）、approve-with-payload（`a:` tool-result part 结果=答案 + 续跑下一轮）、deny 回填、校验 400
- [x] `pnpm -r verify` 绿（server 4 套件 + web tsc，全仓 EXIT 0）