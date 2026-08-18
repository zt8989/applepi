import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import {
  Harness,
  bashTool,
  strReplaceEditorTool,
  denylistExtension,
} from '@harness/core';

const harness = new Harness();

// Built-in tools.
harness.registerExtension((api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
});

// Outermost security layer (priority 1000): vetoes dangerous bash commands.
harness.registerExtension(denylistExtension);

// Auto-discover local extensions dropped into <app>/extensions/ (sibling of src/).
const extDir = new URL('../extensions/', import.meta.url).pathname;
const loaded = await harness.loadExtensionsFromDir(extDir);
if (loaded.length) {
  console.error(`[harness] loaded local extensions: ${loaded.join(', ')}`);
}

function pickModel(): any {
  const provider = process.env.LLM_PROVIDER ?? 'openai';
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    return anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-latest');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }
  return openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
}

const model = pickModel();
const prompt =
  process.argv[2] ??
  'List the files in the current directory using the bash tool.';

const messages = await harness.run(prompt, model);

for (const m of messages) {
  console.log(`\n=== ${m.role} ===`);
  const c: any = m.content;
  if (typeof c === 'string') {
    console.log(c);
  } else {
    console.log(JSON.stringify(c, null, 2));
  }
}
