# 04: 挂起审批 = 未闭合 tool_call 区间（tool/approval-pending 删除）

**What to build:** 工具批准的挂起与恢复不再依赖专门事件：ask 工具暂停时其 `tool_call/start` 区间保持开放；用户决定后写 `tool_call/end { decision: 'approve' | 'deny' }`（deny 不执行工具但区间照常闭合）；恢复方改为扫描「最早有 start 无 end 的 tool_call 区间」（按 toolCallId 配对）推导当前待审批；`tool/approval-pending` 事件与按事件名查找的原语退役。同轮多个待审批工具逐个闭合，下一个未闭合区间自然浮现为当前待审批。已知歧义（执行中崩溃也表现为开放区间，会被误读为待审批）按 spec 接受，不加 phase 区分字段。

**Blocked by:** 02（tool_call/start 必须已写入，未闭合区间推导才成立）

**Status:** ready-for-agent

- [ ] 挂起路径不再写 `tool/approval-pending`（含同轮下一待审批的追写）
- [ ] approve 后执行完成写 `tool_call/end { decision: 'approve' }` + tool_result 区间；deny 写 `{ decision: 'deny' }` 且工具不执行
- [ ] 审批恢复从「读最后一个 approval-pending 事件」切换为「扫描最早未闭合 tool_call 区间」，推导结果与消息日志的待审批集合一致
- [ ] 同轮多个 ask 工具：逐个审批后，下一个未闭合区间浮现为当前待审批
- [ ] `tool/approval-pending` 事件名与按事件名查找原语从代码中移除（无调用方）
- [ ] core 与 server 请求级测试更新（含多段审批恢复、deny 闭合），`pnpm -r verify` 全绿