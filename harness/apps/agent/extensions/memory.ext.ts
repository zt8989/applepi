// Thin local extension: wires the @harness/extensions memory reference
// extension into this agent. Dropped into <app>/extensions/ so the loader
// discovers it automatically (no harness/loader code change needed).
import { createMemoryExtension } from '@harness/extensions';

export default createMemoryExtension({ filePath: 'harness-memory.json' });
