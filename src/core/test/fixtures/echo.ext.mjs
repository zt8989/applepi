// Auto-discovery fixture for @harness/core loader tests.
// Plain .mjs so it loads under `node` (the smoke test imports compiled core/dist,
// where a .ts extension would not be importable without a TS loader).
// Mirrors what a real *.ext.ts extension does: export a `setup(api)` that
// registers a tool via the pull-mode contract (Q9).
export default function setup(api) {
  api.registerTool({
    name: 'echo',
    description: 'Echo the provided message back. (fixture for loader test)',
    parameters: { type: 'object', properties: { msg: { type: 'string' } } },
    execute: async (args) => `echo: ${JSON.stringify(args)}`,
  });
}
