# 11. 仓库布局

> [10 LLM 配置 ←](10-llm-config.md) · [索引](../architecture.md) · [12 待确认项 →](12-open-questions.md)

```
applepi/
├── package.json            # workspace 编排器（build / dev / dev:web / test / verify）
├── pnpm-workspace.yaml     # packages: ["packages/*", "apps/*"]
├── tsconfig.base.json      # 共享编译配置
├── packages/
│   ├── core/               # @applepi/core：深模块 llm(stream)·loop(stream-loop)·session·config·security·trace + Harness 壳（无工具、无洋葱）
│   ├── bundle/             # @applepi/bundle：base / standard 能力包，纯声明 (env)=>({prompt,tools}) + app 侧装配助手
│   └── extension/          # @applepi/extension：参考工具 bash/sre + 能力工厂 memory/skills
├── apps/
│   ├── web/                # @applepi/web：页面壳，Next.js（assistant-ui + Tailwind v4），[§9](09-server-web-tui.md)
│   └── tui/                # @applepi/tui：终端界面（Ink 7，Claude Code 风格），[§9](09-server-web-tui.md)
├── scripts/                # dev-web.mjs / dev-tui.mjs（build-first + ensure server）
├── docs/
│   ├── README.md           # Wiki 首页
│   ├── architecture.md     # 架构导航总页（各章在 docs/architecture/ 分块）
│   ├── architecture/       # 架构分块（01 概览 ~ 13 待确认项）
│   ├── design-principles.md
│   ├── adr/                # ADR-0001 ~ 0018
│   └── agents/             # agent 协作约定
└── CONTEXT.md              # 术语表 + 已锁定决策（单一事实来源）
```

- **构建策略**：build-first，跑 web / test 前先构建依赖包（`pnpm -r build` 拓扑序自动处理）。
- **验证**：`pnpm verify` = build + 各包测试（core / extension / bundle / server / tui）。