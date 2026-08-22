# 04: plan + goal 能力 —— 克隆 01 的状态类形态 ×2

**What to build:** standard 会话中模型可记录分步计划并随执行推进条目状态（plan），以及设定/修改/清除会话目标（goal）；两者的当前状态每轮实时进入提示词——计划摘要在场让复杂任务过程可回看，目标在场防止长对话跑题。两者均为 #01 验证过的 memory 形态（project root 内文件态 + 写/读工具 + 实时 prompt 片段），克隆其模式即可，不引入新机制。

**Blocked by:** 01（todo tracer 弁验证过的形态与测试先例）。

**Status:** resolved

- [x] plan / goal 各自以 Capability 契约注册进注册表（`plan.ts` / `goal.ts` + `CAPABILITIES` + `index.ts` 导出）；接线后两个声明 id 均不再打 warn（bundle 测试 warn 数 6→4 验证）
- [x] 各自文件态落盘 root 内 `.harness/plan.json` / `.harness/goal.json`；写工具权限自决同 #01（readonly 自拒 / workspace/fullaccess 放行），经 executeTool + 级别 ctx 测试
- [x] goal 支持清除；清除后提示词片段缺席（file 删除）；plan 的 done/clear 变更当轮即反映进片段
- [x] 装配缝断言：landed 列表加 plan/goal、`Tools available` 更新；base bundle 不受影响
- [x] 装配缝（bundle 9 项）+ 行为测试（plan 20 项 / goal 15 项）全绿
