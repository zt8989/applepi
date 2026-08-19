// End-to-end check for the MCP reference extension, driven without a real
// LLM/API key by injecting a fake `llmCall` into runLoop. Reproduces the real
// Harness + onion bus + built-in loop, loads the mcp extension, and asserts
// that `mcp_call` bridges to an external server by shelling out through bash
// (the command the fake executor receives) and returns the server's output back
// into the conversation (spec §9.3 / Q8-A / Q16). No real `mcp-cli` needed.
import { Harness, bashTool, strReplaceEditorTool, denylistExtension, runLoop } from '../../core/index.js';
import { createMcpExtension } from '../../extensions/index.js';

const harness = new Harness();

// Built-in tools + outermost denylist (same wiring as main.ts) + the mcp bridge.
harness.registerExtension((api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
});
harness.registerExtension(denylistExtension);

// Fake `mcp-cli`: record the bash command and return a canned server response.
let capturedCmd = '';
const fakeExec = async (cmd: string): Promise<string> => {
  capturedCmd = cmd;
  return JSON.stringify({ result: 'file contents from external MCP server' });
};
harness.registerExtension(createMcpExtension({ executor: fakeExec }));

// Fake LLM: turn 1 calls mcp_call; the bridged output should land in the
// conversation (tool result appended by runLoop). turn 2 we assert on it.
let turn = 0;
let bridgedBack = '';
const fakeLlm: any = async ({ messages }: any) => {
  turn++;
  if (turn === 1) {
    return {
      text: 'calling mcp',
      toolCalls: [
        {
          toolCallId: 'm1',
          toolName: 'mcp_call',
          args: { server: 'fs', tool: 'read', args: '{"path":"/tmp/x"}' },
        },
      ],
    };
  }
  bridgedBack = (messages ?? [])
    .filter((m: any) => m.role === 'tool')
    .map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    )
    .join('\n');
  return { text: 'done' };
};

const messages: any[] = [];
await runLoop(harness, messages, { model: {}, llmCall: fakeLlm, maxTurns: 6 });

console.log('--- bash command run by mcp_call:', capturedCmd);
console.log('--- bridged output in conversation:', bridgedBack.slice(0, 120));

const okBridge =
  capturedCmd === `mcp-cli 'fs' 'read' '{"path":"/tmp/x"}'` &&
  bridgedBack.includes('file contents from external MCP server');

if (okBridge) {
  console.log('check-mcp: OK');
} else {
  console.error('check-mcp: FAIL');
  process.exit(1);
}
