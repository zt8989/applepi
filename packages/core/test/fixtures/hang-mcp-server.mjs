#!/usr/bin/env node
// Hangs during the MCP handshake: reads stdin but never answers `initialize`.
// Simulates `npx -y <pkg>` still resolving/downloading when one-shot exits.
import { writeFileSync } from 'node:fs';
if (process.env['HANG_MARKER']) writeFileSync(process.env['HANG_MARKER'], String(process.pid));
process.stdin.resume();
setInterval(() => {}, 2 ** 30);
