import type { ProviderProtocol, ReasoningLevel, StreamLoopOpts } from '@applepi/core';
import { getSessionModel, sessionReasoningLevel } from '../server.js';

/**
 * Request-level test seam (ADR-0017 §8): createApp accepts per-route seams so
 * route tests run without a browser AND without a real provider — an injected
 * model stub + a fake streamText, exactly like core's stream-loop tests.
 * Production callers (web shell delegate routes) never pass a seam.
 *
 * The streamText type is DERIVED from core's StreamLoopOpts (not imported from
 * 'ai' directly): pnpm installs a physically separate 'ai' copy per package,
 * and two `typeof import('ai').streamText` declarations from different copies
 * are unrelated types (TS2719). One source of truth keeps them identical.
 */
export interface ChatSeam {
  /** Injected model (skips getSessionModel resolution). */
  model?: any;
  /** Injected streamText (fake LLM). */
  streamTextCall?: StreamLoopOpts['streamTextCall'];
}

export interface ResolvedSeam {
  model: any;
  protocol: ProviderProtocol;
  reasoningLevel: ReasoningLevel;
}

/**
 * Resolve the model/protocol/reasoning trio for a segment: the seam's injected
 * model (tests) or the real provider cascade. Shared by /api/chat and
 * /api/chat/approve so both segments resolve identically.
 */
export async function resolveSeam(
  seam: ChatSeam | undefined,
  workspace: string,
  sessionId: string,
): Promise<ResolvedSeam> {
  if (seam?.model) {
    return { model: seam.model, protocol: 'openai-completions', reasoningLevel: 'medium' };
  }
  const resolved = await getSessionModel(workspace, sessionId);
  return {
    model: resolved.model,
    protocol: resolved.protocol,
    reasoningLevel: await sessionReasoningLevel(workspace, sessionId),
  };
}