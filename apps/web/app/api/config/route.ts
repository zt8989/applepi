import { resolveLlmConfig } from '@applepi/core';
import type { ReasoningLevel } from '@applepi/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface LlmConfigResponse {
  provider: string;
  model: string;
  /** Global default reasoning level (resolved). */
  reasoningLevel?: ReasoningLevel;
}

/**
 * GET /api/config — expose non-secret LLM settings so the composer toolbar can
 * display the active (last-used) model and context budget.
 */
export async function GET() {
  try {
    const cfg = await resolveLlmConfig();
    const body: LlmConfigResponse = {
      provider: cfg.provider,
      model: cfg.model,
      reasoningLevel: cfg.reasoningLevel,
    };
    return Response.json(body);
  } catch (e: any) {
    // No config yet (e.g. fresh install) → empty model; UI shows 默认模型.
    return Response.json({ provider: '', model: '' } as LlmConfigResponse);
  }
}
