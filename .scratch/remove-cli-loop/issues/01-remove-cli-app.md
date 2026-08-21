# 01 — 删除 CLI 应用（apps/agent）

**What to build:** Web 界面成为**唯一**用户接口。整个 CLI 应用包——交互式 REPL、它的插件加载器与示例插件、以及它的六个 key-free 检查脚本（denylist / memory / skills / session / security / ext）——全部删除，连同所有引用它的 build / dev / verify 编排脚本。删除后脚本与商店（workspace、文档包、CLI `@applepi/bundle` 装配）其余包照常构建与验证。此步之后，非流式 loop（`runLoop`）不再有任何 app 消费方（其在本应用 `check-*` 里的用法也一并消失）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] CLI 应用包及其全部文件不再存在于 workspace（REPL 主入口、插件加载器、示例插件、六个 check 脚本）
- [ ] 根/各包脚本不再引用 CLI 包（dev / check-* / verify 的接线与 build 入口移除；`@applepi/agent` 从 workspace 与相关 package.json 依赖消失）
- [ ] 剩余包 `pnpm -r build` 与 `pnpm -r test` 全绿（web 不受影响）；根 `verify` 移除 CLI 相关条目后仍绿
- [ ] grep 仓库无残留 `@applepi/agent` / CLI 特有符号（node_modules、dist 除外）
