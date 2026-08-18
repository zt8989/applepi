# Code Review — T01 核心运行时 + 端到端 loop

- **范围**: `b909218...HEAD`(`98843f9` + `bfbcd9d`),15 文件 / +1167
- **Spec 来源**: `.scratch/harness/issues/01-core-runtime-loop.md` + `harness-design-spec.md`
- **审查方式**: 直接读源码 + 规格(原 `/code-review` 子代理因代理 502 中断,改本地审查)
- **结论**: **PASS** —— 实现忠实落地锁定规格,无阻断问题;以下为 minor / low 级偏差与建议。

---

## Standards 轴(无 CODING_STANDARDS.md,仅走 smell baseline)

- **S1 Speculative Generality** — `HarnessApi.getTools()` 不在规格 §3.3 的接口清单里,且当前无外部调用方(`buildToolDefs` 直接迭代 `this.tools`)。保留作为公共 API 合理,但属 spec 之外增量。低。
- **S2 Primitive Obsession / Mysterious Name** — `ctx.state.__vetoed` 是魔法字符串约定(`bus.ts` 写、`loop.ts` 读)。建议提成具名常量(如 `VETOED_KEY`)。低。
- **S3 Duplicated Code** — `bash.ts` 与 `str_replace_editor.ts` 的 `catch (e:any) { return \`ERROR: ${e?.message ?? e}\` }` 重复。可抽 `toErr(e)` 辅助。琐碎级。
- **S4 Primitive Obsession** — `LoopOpts.model: any` / `Harness.run(model: any)`。规格明确"any[] 以跨 AI SDK 版本",此处置可接受的版本漂移妥协。低。

---

## Spec 轴

### 正确实现(核对通过)
- 洋葱 3 栈(session/llm/tool)+ priority 排序 + veto(不调 next)+ 逐层 try/catch 软隔离 ✓(§4)
- 自有执行 loop:`generateText` 不带 `execute`,工具经 `tool` 洋葱栈自执行、结果回灌 ✓(§5)
- denylist 以 priority 1000 注册为最外层 `tool` 中间件,veto 危险 bash ✓(§7);冒烟确认 `rm -rf /` → BLOCKED
- Vercel AI SDK + zod tool schema ✓(Q11/Q13)
- `loadExtensionsFromDir` 扫描本地 `extensions/` 的 `*.ext.{ts,js,mjs}` ✓(§3.1 主路径)
- `api.ctx` 暴露 `SessionContext`(Q9-b)✓
- `pnpm -r build` 全绿、`smoke.mjs` 6/6、`agent` 无 key 优雅报错 ✓

### 偏差 / 缺口
- **Sp1 denylist 审计点(low)** — 规格 §7 原话"最外层、退出最晚,能审到所有内层改写后的**最终命令**",暗示应在 `next()` **之后**审。实现在 `next()` **之前**(entry)审 `ctx.toolArgs.command`。鉴于 Q6 信任模型(扩展同进程=授信,denylist 只防模型犯错),entry 检查已满足意图;但代码注释称"inspects ... on entry, before any trusted inner middleware runs"与规格字面"最终命令"不完全一致。可选:(a) 接受并修正注释;(b) 把检查移到 post-next 以字面契合 §7。
- **Sp2 `ctx.response` 未接线(low)** — 规格 §4 标 llm 栈"出:改 response",但 `loop.ts` 从不读取 `ctx.response`,llm 中间件改写 `ctx.response` 是空操作。要么在 llm 栈返回后接 `r = ctx.response ?? r`,要么从 `Ctx` 删掉该字段。
- **Sp3 loader 落点(low)** — 规格 §10 骨架把 loader 列为 `src/core/loader.ts` 独立文件;实现折进 `harness.ts`(`loadExtensionsFromDir`)。功能正确,仅结构偏离建议骨架。
- **Sp4 package.json `harness-ext` 字段(无动作)** — 规格 §3.1 标为可选次要路径,未实现,与主路径"本地目录扫描"不冲突。
- **Sp5 `@harness/extensions` 包(无动作)** — 按 T01 ticket 明确 defer 到 T04–T06,符合本期范围。

---

## 建议(均非阻断)
1. 接线或删除 `ctx.response`(Sp2)。
2. 明确 denylist 审计点(entry vs post-next)并统一注释(Sp1)。
3. 抽 `toErr()` 辅助;将 `__vetoed` 魔法串提成常量(S2/S3)。
4. 决定 `getTools()` 去留(不在 spec,当前未用)(S1)。

---

*审查员: WorkBuddy(本地直审,替代中断的子代理审查)*
