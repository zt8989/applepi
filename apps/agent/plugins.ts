import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSpec, Ctx, SessionContext } from '@applepi/core';

/**
 * App-layer plugin loader (ADR-0015). The `registerExtension` machinery left
 * core; the app owns the plugin tail. A plugin is an external, **append-only**
 * capability: it contributes flat prompt fragments at the tail and registers
 * new tools/skills. It cannot reorder or remove base/standard internals.
 *
 * Plugin contract — a `*.ext.ts` file exports a default of either:
 *   - a plain declarative object `PluginSpec` (`{ prompt?, tools? }`), or
 *   - a producer function `(env, session) => PluginSpec` (for state-aware plugins).
 * Either may also be named `export const plugin`, `export const setup`.
 * Files exporting neither are treated as "not a plugin" and skipped.
 */
export interface PluginSpec {
  /** Plugin name (defaults to the file basename). */
  name?: string;
  /** Flat prompt fragments appended at the tail (ADR-0015 plugin layer). */
  prompt?: string[];
  /** Tools registered when the plugin is loaded. */
  tools?: ToolSpec[];
}

export interface PluginEnv {
  cwd: string;
  workspace?: string;
}

type PluginExports = PluginSpec | ((env: PluginEnv, session: SessionContext) => PluginSpec);

/**
 * Scan `dir` for `*.ext.{ts,js,mjs}` files and load each as a plugin.
 * Missing directory → empty (non-fatal). A cache-busting query (`?v=ts`) is
 * appended so `/reload` actually re-evaluates edited plugin modules.
 */
export async function loadPlugins(dir: string): Promise<PluginSpec[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const plugins: PluginSpec[] = [];
  const extFiles = files.filter((f) => /\.ext\.(ts|js|mjs)$/.test(f));
  for (const f of extFiles) {
    const url = pathToFileURL(path.join(dir, f)).href + `?v=${Date.now()}`;
    const mod: any = await import(/* webpackIgnore: true */ url);
    const ex: PluginExports | undefined =
      mod.default ?? mod.plugin ?? mod.setup;
    const name = f.replace(/\.ext\.(ts|js|mjs)$/, '');
    if (typeof ex === 'function') {
      plugins.push({ name, ...ex({ cwd: process.cwd() }, { history: [], config: {}, scratch: {} }) });
    } else if (ex && typeof ex === 'object') {
      plugins.push({ name, ...ex });
    }
  }
  return plugins;
}
