import { resolveLlmConfig } from '@applepi/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface LlmConfigResponse {
  provider: string;
  model: string;
}

/**
 * GET /api/config — expose non-secret LLM settings so the composer toolbar can
 * display the active model and context budget.
 */
export async function GET() {
  try {
    const cfg = await resolveLlmConfig();
    const body: LlmConfigResponse = {
      provider: cfg.provider,
      model: cfg.model,
    };
    return Response.json(body);
  } catch (e: any) {
    return new Response(`llm config error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}
