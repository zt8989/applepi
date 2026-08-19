import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SetupFn, HarnessApi } from '../core/index.js';

const execAsync = promisify(exec);

export interface McpOptions {
  /**
   * The CLI used to reach external MCP servers. Defaults to `mcp-cli`.
   * The whole point of this extension (Q8/A, Q16) is that MCP does NOT get a
   * dedicated subprocess bridge — it degrades to "run one command via bash".
   */
  cliName?: string;
  /**
   * Command executor. Defaults to a real shell-out (same mechanism as the
   * built-in `bash` tool). Inject a fake in tests so we can verify the bridge
   * wiring without a real `mcp-cli` binary on PATH.
   */
  executor?: (cmd: string) => Promise<string>;
}

/**
 * Build the bash command that reaches an external MCP server through mcp-cli.
 * Kept as a pure function so it is unit-testable without a real binary.
 */
export function buildMcpCommand(
  cliName: string,
  server: string,
  tool: string,
  argsJson: string,
): string {
  // Single-quote the JSON args so nested quotes survive the shell.
  return `${cliName} ${shellQuote(server)} ${shellQuote(tool)} '${argsJson.replace(/'/g, "'\\''")}'`;
}

/** Minimal POSIX shell quoting for a single argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * MCP reference extension (spec §9.3 / Q8-A). Registers a single `mcp_call`
 * tool that bridges to an external MCP server by shelling out to `mcp-cli`
 * through the same exec path the built-in `bash` tool uses. No dedicated
 * subprocess, no JSON-RPC client — just one bash command.
 */
export function createMcpExtension(options: McpOptions = {}): SetupFn {
  const cliName = options.cliName ?? 'mcp-cli';
  const run = options.executor ?? defaultExecutor;

  return (api: HarnessApi) => {
    api.registerTool({
      name: 'mcp_call',
      description: `Call a tool on an external MCP server. The harness bridges to the server by running \`${cliName} <server> <tool> <args>\` via bash (no dedicated subprocess). Requires \`${cliName}\` to be installed on PATH.`,
      parameters: z.object({
        server: z.string().describe('MCP server name known to mcp-cli'),
        tool: z.string().describe('Tool name exposed by that server'),
        args: z
          .string()
          .describe('Tool arguments as a JSON string, e.g. \'{"q":"hello"}\''),
      }),
      execute: async (
        args: { server: string; tool: string; args: string },
        _ctx,
      ) => {
        const cmd = buildMcpCommand(cliName, args.server, args.tool, args.args);
        try {
          const out = await run(cmd);
          return out || '(no output)';
        } catch (e: any) {
          return `ERROR: ${e?.message ?? e}`;
        }
      },
    });
  };
}

/** Default executor: shell out via the same exec path as the bash tool. */
async function defaultExecutor(cmd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 30000,
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return [stdout, stderr].filter(Boolean).join('\n');
  } catch (e: any) {
    throw e;
  }
}

/** Default MCP extension (real mcp-cli on PATH). */
export const mcpExtension = createMcpExtension();
