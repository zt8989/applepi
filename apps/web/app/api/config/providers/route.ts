import { getProviders, saveProviders } from '@/lib/server';
import { PROVIDER_PROTOCOLS, BUILTIN_PROVIDERS, type ProviderConfig, type ProviderProtocol } from '@applepi/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[a-z][a-z0-9-]*$/;

export async function GET() {
  try {
    const data = await getProviders();
    return Response.json(data);
  } catch (e: any) {
    return new Response(`providers error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      providers: Record<string, ProviderConfig & { apiKey?: string }>;
      lastUsedModel?: { providerId: string; modelId: string };
    };
    if (!body || typeof body.providers !== 'object') {
      return new Response('missing providers map', { status: 400 });
    }
    // Validate every provider id + protocol + required fields. A builtin preset
    // may be enabled with a minimal entry (apiKeyRef only); its protocol falls
    // back to the code preset at load time, so protocol is not required there.
    for (const [id, p] of Object.entries(body.providers)) {
      if (!ID_RE.test(id)) {
        return new Response(`非法 Provider ID "${id}"（须以小写字母开头，仅含 [a-z0-9-]）`, { status: 400 });
      }
      const isBuiltin = id in BUILTIN_PROVIDERS;
      if (!isBuiltin && !PROVIDER_PROTOCOLS.includes(p.protocol as ProviderProtocol)) {
        return new Response(`provider "${id}" 协议非法: ${p.protocol}`, { status: 400 });
      }
      if (!p.apiKeyRef) {
        return new Response(`provider "${id}" 缺少 apiKeyRef`, { status: 400 });
      }
    }
    await saveProviders(body);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`save providers error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}
