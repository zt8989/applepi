#!/usr/bin/env node
/**
 * 一个**最小的 MCP stdio 服务器**，只为离线测试。
 *
 * ## 为什么不用 `npx @modelcontextprotocol/server-filesystem`
 *
 * 那要联网、要下包、还要等 npm —— 测试会变慢、会因网络挂掉，断言也会跟着环境漂。
 * 这个 fixture 只实现协议里真正会被走到的四个方法，进程内起、进程内退：
 *
 * - `initialize`（回显客户端请求的 protocolVersion，必须落在 SUPPORTED_PROTOCOL_VERSIONS 里）
 * - `tools/list` → 一个 `echo` 工具
 * - `tools/call` → 返回 `echo: <text>`
 * - `resources/list` / `resources/templates/list` → 空（MCP 扩展靠它判 `hasResources`）
 *
 * 传输是 MCP 的 stdio：**按行分隔的 JSON-RPC**（不是 LSP 的 Content-Length 帧）。
 * `@earendil-works/pi-mcp` 的 `StdioTransport` 就是按 `\n` 切的（见它的 `handleStdout`）。
 */
import process from 'node:process';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back. Input: text. Output: "echo: <text>".',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  // 通知（`notifications/initialized`）没有 id，按协议不回。
  if (message.id === undefined) return;
  const { id, method, params } = message;
  const ok = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => send({ jsonrpc: '2.0', id, error: { code, message: text } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        instructions: 'Fake MCP server for offline tests. One tool: echo.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== 'echo') return fail(-32602, `unknown tool: ${String(name)}`);
      return ok({
        content: [{ type: 'text', text: `echo: ${String(args.text ?? '')}` }],
        isError: false,
      });
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}