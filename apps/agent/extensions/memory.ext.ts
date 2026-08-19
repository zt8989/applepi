// Thin local extension: wires the ../../extensions/index.js memory reference
// extension into this agent. Dropped into <app>/extensions/ so the loader
// discovers it automatically (no harness/loader code change needed).
import { createMemoryExtension } from '@applepi/extensions';

export default createMemoryExtension({ filePath: 'harness-memory.json' });
