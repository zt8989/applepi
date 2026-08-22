import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Shared state-file helpers for the declarative state capabilities (todo /
 * plan / goal). Each capability keeps one small JSON file under a dot-dir
 * inside the workspace root — the same trusted, extension-fixed location
 * discipline as memory's harness-memory.json. Because the file lives inside
 * the workspace root by construction, the WORKSPACE-level write gate is
 * satisfied without a per-call path check; tools still self-determine at
 * readonly (ADR-0009).
 */

/** State file path for capability `name` under `root` (the workspace root). */
export function stateFilePath(root: string, name: string): string {
  return path.join(root, '.harness', name);
}

/** Load a JSON state file; missing/corrupt file -> null (never throws). */
export async function loadJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Sync variant for capability `prompt()` renders (flat prompt is assembled per turn). */
export function loadJsonSync<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic-ish write of a JSON state file (mkdir -p included). */
export async function saveJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

/** Delete a state file (clear semantics); missing file is a no-op. */
export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}