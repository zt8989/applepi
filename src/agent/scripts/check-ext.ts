// Key-free verification that a real *.ext.ts in <app>/extensions/ is
// auto-discovered and its tool registered. Run with tsx:
//   pnpm --filter agent check-ext
import { Harness } from '../../core/index.js';

const harness = new Harness();
const extDir = new URL('../extensions/', import.meta.url).pathname;
const loaded = await harness.loadExtensionsFromDir(extDir);

console.log('loaded extensions:', loaded);
const tools = harness.api.getTools().map((t) => t.name);
console.log('registered tools:', tools);

if (!tools.includes('hello')) {
  console.error('FAIL: hello tool not auto-discovered');
  process.exit(1);
}
console.log('OK: extension auto-discovery works (tsx runtime)');
