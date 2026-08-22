// Standalone: ensure the shared applepi server is running, print its URL.
// Used by the web shell dev flow and the future TUI (ADR-0017 attach).
import { ensureServer } from '@applepi/server';

const { url, spawned } = await ensureServer();
console.log(spawned ? `applepi server started at ${url}` : `applepi server already running at ${url}`);