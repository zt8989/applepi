import { createMcpExtension } from '../../extensions/index.js';

// Auto-discovered by the harness loader (no harness/loader code change needed).
// Bridges to external MCP servers via `mcp-cli` on PATH — no dedicated subprocess.
export default createMcpExtension();
