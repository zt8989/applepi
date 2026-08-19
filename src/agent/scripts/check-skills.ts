// End-to-end check for the skills reference extension, driven without a real
// LLM/API key by injecting a fake `llmCall` into runLoop. Reproduces the real
// Harness + onion bus + built-in loop, loads the skills extension, and asserts
// that a loaded skill's markdown is injected into the next LLM call's system
// prompt (the `llm` onion stack rewriting ctx.messages, per spec §9.2 / Q15).
import { Harness, bashTool, strReplaceEditorTool, denylistExtension, runLoop } from '../../core/index.js';
import { createSkillsExtension } from '../../extensions/index.js';

const harness = new Harness();

// Built-in tools + outermost denylist (same wiring as main.ts).
harness.registerExtension((api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
});
harness.registerExtension(denylistExtension);
harness.registerExtension(createSkillsExtension());

const SKILL_CONTENT =
  'Always answer in a friendly, polite tone and start with "Hi there!".';

// Fake LLM: turn 1 loads a skill via skill_load; turn 2 we capture the messages
// the model would see and assert the skill content is in the system prompt.
let turn = 0;
let capturedSystem = '';
const fakeLlm: any = async ({ messages }: any) => {
  turn++;
  if (turn === 1) {
    return {
      text: 'loading',
      toolCalls: [
        {
          toolCallId: 't1',
          toolName: 'skill_load',
          args: { name: 'polite', content: SKILL_CONTENT },
        },
      ],
    };
  }
  capturedSystem = (messages ?? [])
    .filter((m: any) => m.role === 'system')
    .map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    )
    .join('\n');
  return { text: 'done' };
};

const messages: any[] = [];
await runLoop(harness, messages, { model: {}, llmCall: fakeLlm, maxTurns: 6 });

console.log('--- captured system prompt:', capturedSystem.slice(0, 220));

const okInjected =
  capturedSystem.includes(SKILL_CONTENT) && capturedSystem.includes('[Skill: polite]');

if (okInjected) {
  console.log('check-skills: OK');
} else {
  console.error('check-skills: FAIL');
  process.exit(1);
}
