# 6. 工具与 Vercel AI SDK 映射

> [05 内置 Agent Loop ←](05-agent-loop.md) · [索引](../architecture.md) · [07 安全模型 →](07-security.md)

扩展/bundle 注册工具用 **zod**（而非裸 JSON Schema）：

```ts
harness.registerTool({
  name: "grep",
  description: "在文件中搜索正则",
  parameters: z.object({ pattern: z.string(), path: z.string() }),
  execute: async (args, ctx) => runGrep(args),
});
```

核心在注册时把 `ToolSpec` 转成 AI SDK `tool()`，并入 `streamText({ tools })`。