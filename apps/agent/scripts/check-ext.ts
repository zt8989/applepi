// Key-free verification that a real *.ext.ts in <app>/extensions/ is
// discovered by the app-layer plugin loader (ADR-0015) and its tool is ready.
// Run with tsx:
//   pnpm --filter agent check-ext
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../plugins.js';

// fileURLToPath (not .pathname): .pathname yields a `/C:/...` root-relative
// path on Windows, which fs.readdir cannot resolve.
const extDir = fileURLToPath(new URL('../extensions/', import.meta.url));
const plugins = await loadPlugins(extDir);

const names = plugins.flatMap((p) => (p.tools ?? []).map((t) => t.name));
console.log('loaded plugins:', plugins.map((p) => p.name ?? '(unnamed)'));
console.log('plugin tools:', names);

if (!names.includes('hello')) {
  console.error('FAIL: hello tool not discovered by the plugin loader');
  process.exit(1);
}
console.log('OK: plugin loader discovers hello.ext.ts (tsx runtime)');
