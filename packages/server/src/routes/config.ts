import { resolveLlmConfig, PROVIDER_PROTOCOLS, REASONING_LEVELS, BUILTIN_PROVIDERS } from '@applepi/core';
import type { ProviderConfig, ProviderProtocol, ReasoningLevel } from '@applepi/core';
import {
  configFileHidden,
  getGeneralDefaults,
  getProviders,
  listModels,
  openConfigFile,
  saveGeneralDefaults,
  saveLastUsed,
  saveLastUsedLevel,
  saveProviders,
} from '../server.js';

/** GET /api/config — non-secret LLM settings for the composer toolbar. */
export async function handleConfigGet(): Promise<Response> {
  try {
    const cfg = await resolveLlmConfig();
    return Response.json({
      provider: cfg.provider,
      model: cfg.model,
      reasoningLevel: cfg.reasoningLevel,
    });
  } catch {
    // No config yet (e.g. fresh install) → empty model; UI shows 默认模型.
    return Response.json({ provider: '', model: '' });
  }
}

/** GET /api/config/general — the current global default slots (ADR-0016). */
export async function handleConfigGeneralGet(): Promise<Response> {
  try {
    return Response.json(await getGeneralDefaults());
  } catch (e: any) {
    return new Response(`general error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

/** PUT /api/config/general — overwrite the global default slots. */
export async function handleConfigGeneralPut(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      model?: { providerId: string; modelId: string };
      reasoningLevel?: string;
      permissionLevel?: string;
    };
    await saveGeneralDefaults(body);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`save general error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

/** GET /api/config/providers — user providers + available builtins + defaults. */
export async function handleConfigProvidersGet(): Promise<Response> {
  try {
    return Response.json(await getProviders());
  } catch (e: any) {
    return new Response(`providers error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** PUT /api/config/providers — persist the full desired provider set. */
export async function handleConfigProvidersPut(req: Request): Promise<Response> {
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

/** GET /api/config/models?providerId= — catalog from an openai-compatible endpoint. */
export async function handleConfigModelsGet(req: Request): Promise<Response> {
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

/** POST /api/config/last-used — persist the global default model. */
export async function handleConfigLastUsedPost(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { providerId: string; modelId: string };
    if (!body.providerId || !body.modelId) {
      return new Response('missing providerId/modelId', { status: 400 });
    }
    await saveLastUsed(body.providerId, body.modelId);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`last-used error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

/** POST /api/config/last-used-level — persist the global default reasoning level. */
export async function handleConfigLastUsedLevelPost(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { level?: string };
    const level = body.level;
    if (!level || !(REASONING_LEVELS as readonly string[]).includes(level)) {
      return new Response(`level must be one of: ${REASONING_LEVELS.join('|')}`, { status: 400 });
    }
    await saveLastUsedLevel(level as ReasoningLevel);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`last-used-level error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

/** GET /api/config/open-file — probe availability (no side effect). */
export async function handleConfigOpenFileGet(): Promise<Response> {
  return Response.json({ hidden: configFileHidden() });
}

/** POST /api/config/open-file — open settings.json in the OS default editor. */
export async function handleConfigOpenFilePost(): Promise<Response> {
  try {
    return Response.json(await openConfigFile());
  } catch (e: any) {
    return new Response(`open-file error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}