// Plain-node unit test for the MCP extension. Run after `pnpm --filter
// @harness/extensions build`. No API key, no real mcp-cli binary needed —
// we inject a fake executor that records the bash command it was asked to run.
import assert from 'node:assert';
import { createMcpExtension, buildMcpCommand } from '../dist/index.js';

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// --- minimal fake HarnessApi ---
function makeApi(opts = {}) {
  const tools = [];
  const api = {
    tools,
    registerTool: (spec) => tools.push(spec),
    use: () => {},
    ctx: { history: [], config: {}, scratch: {} },
    getTools: () => tools,
  };
  return { api, opts };
}

// 1. buildMcpCommand: plain args
assert.equal(
  buildMcpCommand('mcp-cli', 'fs', 'read', '{"path":"/tmp/x"}'),
  `mcp-cli 'fs' 'read' '{"path":"/tmp/x"}'`,
);
ok('buildMcpCommand quotes server/tool and single-quotes JSON args');

// 2. buildMcpCommand: JSON args containing single quotes
const tricky = buildMcpCommand('mcp-cli', 's', 't', `{"q":"it's"}`);
assert.ok(tricky.includes(`'{"q":"it'\\''s"}'`), `unexpected: ${tricky}`);
ok('buildMcpCommand escapes single quotes inside JSON args');

// 3. buildMcpCommand: custom cli name
assert.ok(buildMcpCommand('my-cli', 'a', 'b', '{}').startsWith('my-cli '));
ok('buildMcpCommand honors custom cliName');

// 4. registration: mcp_call present
const calls = [];
const exec = (cmd) => {
  calls.push(cmd);
  return Promise.resolve('{"result":"bridged-from-mcp"}');
};
const { api } = makeApi();
createMcpExtension({ executor: exec })(api);
const mcpTool = api.tools.find((t) => t.name === 'mcp_call');
assert.ok(mcpTool, 'mcp_call tool not registered');
ok('createMcpExtension registers a mcp_call tool');

// 5. mcp_call runs the built command through the injected executor
const out = await mcpTool.execute({ server: 'fs', tool: 'read', args: '{"path":"/tmp/x"}' }, {});
assert.equal(calls.length, 1);
assert.equal(calls[0], `mcp-cli 'fs' 'read' '{"path":"/tmp/x"}'`);
assert.equal(out, '{"result":"bridged-from-mcp"}');
ok('mcp_call shells out to `mcp-cli <server> <tool> <args>` via the bash bridge');

// 6. executor error surfaces as ERROR (same shape as the bash tool)
const failing = (cmd) => Promise.reject(new Error('mcp-cli: command not found'));
const { api: api2 } = makeApi();
createMcpExtension({ executor: failing })(api2);
const t2 = api2.tools.find((t) => t.name === 'mcp_call');
const errOut = await t2.execute({ server: 'x', tool: 'y', args: '{}' }, {});
assert.ok(errOut.startsWith('ERROR: mcp-cli: command not found'), `got: ${errOut}`);
ok('mcp_call surfaces executor errors as ERROR (mirrors bash tool)');

// 7. (iii) denylist note: mcp_call goes through the tool onion stack, so the
// outermost denylist middleware still audits the shelled command. We assert the
// command is the bash-bridge form (the denylist can read ctx.toolArgs.command).
const { api: api3 } = makeApi();
const captured = [];
const exec3 = (cmd) => {
  captured.push(cmd);
  return Promise.resolve('ok');
};
createMcpExtension({ executor: exec3 })(api3);
const t3 = api3.tools.find((t) => t.name === 'mcp_call');
await t3.execute({ server: 's', tool: 't', args: '{}' }, {});
assert.ok(captured[0].startsWith('mcp-cli '), `cmd not a bash bridge: ${captured[0]}`);
ok('mcp_call command is bash-bridge shaped (auditable by the tool-stack denylist)');

console.log(`\n${passed} mcp checks passed.`);
