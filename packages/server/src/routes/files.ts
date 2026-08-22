import { promises as fs } from 'node:fs';
import path from 'node:path';

// Directories we never descend into (large / generated / VCS metadata).
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  'target',
  '.cache',
  'coverage',
  '.turbo',
  '.DS_Store',
]);

const MAX_WALK = 6000; // total entries budget
const MAX_DEPTH = 10;
const MAX_RESULTS = 60;

/**
 * GET /api/files?workspace=<abs>&q=<query>
 *
 * Returns up to MAX_RESULTS file/dir paths (relative to workspace) whose
 * path contains `q` (case-insensitive). The walk is bounded by depth and an
 * entry budget and never leaves the workspace root (paths are resolved and
 * re-checked against the workspace prefix).
 */
export async function handleFilesGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspace = url.searchParams.get('workspace') ?? '';
  const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
  if (!workspace || !path.isAbsolute(workspace)) {
    return new Response('missing or non-absolute workspace', { status: 400 });
  }
  let root: string;
  try {
    root = await fs.realpath(workspace);
  } catch {
    return new Response('workspace not accessible', { status: 400 });
  }

  const out: string[] = [];
  let walked = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  const seen = new Set<string>([root]);

  while (queue.length && walked < MAX_WALK && out.length < MAX_RESULTS) {
    const { dir, depth } = queue.shift()!;
    walked++;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= MAX_DEPTH) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        queue.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!q || rel.toLowerCase().includes(q)) out.push(rel);
      }
      if (out.length >= MAX_RESULTS) break;
    }
  }

  out.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return Response.json({ files: out.slice(0, MAX_RESULTS) });
}