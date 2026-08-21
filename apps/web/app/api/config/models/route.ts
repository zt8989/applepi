import { listModels } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const providerId = new URL(req.url).searchParams.get('providerId');
  if (!providerId) return new Response('missing providerId', { status: 400 });
  try {
    const models = await listModels(providerId);
    return Response.json({ models });
  } catch (e: any) {
    // 405 for unsupported protocol (anthropic); 400 for unknown provider; 500 otherwise.
    const status = /不提供模型列表端点/.test(e?.message ?? '')
      ? 405
      : e?.status === 400
        ? 400
        : 500;
    return new Response(e?.message ?? String(e), { status });
  }
}
