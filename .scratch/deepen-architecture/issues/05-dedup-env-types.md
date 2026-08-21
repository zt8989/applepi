# 05 — 收敛 CapabilityEnv/BundleEnv 重复

**What to build:** `packages/extensions/capability.ts` 的 `CapabilityEnv` 与 `packages/bundle/src/types.ts` 的 `BundleEnv` 字段逐一对齐地重复。让 `CapabilityEnv` 复用 `BundleEnv`（或二者合并为一个类型），去掉字段重复。注意：权限片段的重复渲染已被 #01 的共享 `permissionFragment` 消解，本票只处理 env 类型重复这一残余。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 让 `CapabilityEnv` 复用 / 扩展 `BundleEnv`（或统一为一个类型），更新所有引用。
- [x] 确认 `capabilities.ts` / `capability.ts` 中 env 的使用点仍编译通过。
- [x] `pnpm -r build && pnpm -r test` 全绿。
