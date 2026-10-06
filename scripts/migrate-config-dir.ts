/**
 * 一次性迁移：把旧的 `~/.redux-agent/` 并进 `~/.pi/agent/`。
 *
 * ## 为什么要迁
 *
 * 配置家目录从 `~/.redux-agent` 改成**与 pi 同址**（见 `config-home.ts`）。同一份
 * `models.json` / `auth.json` / `settings.json` / `sessions/` 两边共用，免得改一次
 * 配置要同步两个地方。
 *
 * 改目录 = 换路径，所以旧目录里的**会话与轨迹不会自己跟过来**。这个脚本搬它们。
 *
 * ## 搬什么、不搬什么
 *
 * | | 搬 | 为什么 |
 * | --- | --- | --- |
 * | `sessions/` | ✅ | 历史对话就在这儿，是要保命的东西 |
 * | `traces/` | ✅ | pi 没有这个目录，整搬过去（与 sessions 保持同一批 id） |
 * | `models.json` | 看情况 | 目标是数组形状且 provider 不重复 → 跳过；否则合并 |
 * | `auth.json` | 看情况 | 目标缺失 → 搬；两边都有 → 逐 provider 补缺，不覆盖已有的 |
 * | `settings.json` | 看情况 | 目标缺失 → 搬；两边都有 → 跳过（目标通常更新） |
 *
 * **不覆盖目标已有的东西**：宁可留在旧目录让人自己看，也不要拿旧的覆盖新的。
 * 同名会话文件（id 撞了）也保留在旧目录里 —— 两个工具用不同 id 生成器，撞的概率极低，
 * 真撞了也不该静默丢一份。
 *
 * ## 幂等
 *
 * 跑第二遍是 no-op（没有可搬的东西，或目标已满足条件）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 旧目录名（硬编码：迁移完就不该再有代码用这个名字）。 */
const LEGACY_DIR_NAME = '.redux-agent';
/** 新目录（与 pi 同址）。 */
const TARGET_REL = ['.pi', 'agent'];

/** 合并时用到的 provider 条目形状（其余字段不关心）。 */
interface ProviderLike {
  models?: unknown;
  [key: string]: unknown;
}

/** 日志回调（迁移脚本的输出全走它，方便测试静音）。 */
type Log = (line: string) => void;

/** 读一个 json 对象；不存在、不是对象、或坏了都返回 null（迁移不该因一个坏文件停下来）。 */
function jsonOrNull(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 合并 models.json：目标缺 provider / 目标某个 provider 的 models 还是旧形状（对象 map）时，
 * 源的补上。目标已是数组形状的 provider **不动**（不拿旧的覆盖新的）。
 */
function mergeModels(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): { config: Record<string, unknown>; changed: boolean } {
  const targetProviders = (target.providers ?? {}) as Record<string, ProviderLike>;
  const sourceProviders = (source.providers ?? {}) as Record<string, ProviderLike>;
  const out = { ...target, providers: { ...targetProviders } };
  let changed = false;
  for (const [providerId, sourceProvider] of Object.entries(sourceProviders)) {
    const existing = out.providers[providerId];
    if (!existing) {
      out.providers[providerId] = sourceProvider;
      changed = true;
      continue;
    }
    // 目标已有这个 provider：只有当它的 models 还是旧形状时，才用源的替掉
    // （旧形状会让 pi 整个文件作废，这是必须修的；新版形状不碰）。
    const existingIsLegacy = !!existing.models && !Array.isArray(existing.models);
    if (existingIsLegacy && Array.isArray(sourceProvider.models)) {
      out.providers[providerId] = { ...existing, models: sourceProvider.models };
      changed = true;
    }
  }
  return { config: out, changed };
}

/**
 * 合并 auth.json：目标的 provider 缺 key 时用源的补上。
 * 两边都有的**不覆盖** —— key 会轮换，新的更可能是有效的。
 */
function mergeAuth(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): { config: Record<string, unknown>; changed: boolean } {
  const out = { ...target };
  let changed = false;
  for (const [providerId, sourceAuth] of Object.entries(source)) {
    if (!out[providerId]) {
      out[providerId] = sourceAuth;
      changed = true;
    }
  }
  return { config: out, changed };
}

/**
 * 搬一个目录树里的所有文件（不覆盖已存在的目标）。
 *
 * 用 `renameSync`（同盘就是改名，零拷贝）；跨盘（EXDEV）退回复制。
 * 返回搬了多少个、因为已存在而跳过多少个。
 */
function moveFilesInto(
  srcDir: string,
  destDir: string,
  log: Log,
): { moved: number; skipped: number } {
  if (!existsSync(srcDir)) return { moved: 0, skipped: 0 };
  mkdirSync(destDir, { recursive: true });
  let moved = 0;
  let skipped = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      const sub = moveFilesInto(src, dest, log);
      moved += sub.moved;
      skipped += sub.skipped;
      continue;
    }
    if (!entry.isFile()) continue;
    if (existsSync(dest)) {
      skipped += 1;
      log(`  跳过（目标已有）：${path.relative(homedir(), dest)}`);
      continue;
    }
    try {
      renameSync(src, dest);
    } catch (error) {
      // 跨盘（EXDEV）rename 不行，退回复制。其余错误真的搬不了。
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') copyFileSync(src, dest);
      else throw error;
    }
    moved += 1;
  }
  return { moved, skipped };
}

/** 目标里的空目录（pi 建好但还没会话）可以删掉，让目录干净。 */
function pruneEmptyDirs(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // 删不掉就算了（可能被占用），不是迁移失败。
    }
  }
}
/** 数一个目录树里有多少个文件（dry-run 用，不动任何东西）。 */
function countFiles(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(root, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

export interface MigrateOptions {
  home?: string;
  legacy?: string;
  target?: string;
  log?: Log;
  dryRun?: boolean;
}

/** 迁移报告（给调用者展示 / 测试断言用）。 */
export interface MigrateReport {
  legacy: string;
  target: string;
  dryRun: boolean;
  movedSessions: number;
  skipped: number;
  files: string[];
}

/** 跑迁移。返回一份给调用者展示的报告。 */
export function migrateToPiDir(options: MigrateOptions = {}): MigrateReport {
  const home = options.home ?? homedir();
  const legacy = options.legacy ?? path.join(home, LEGACY_DIR_NAME);
  const target = options.target ?? path.join(home, ...TARGET_REL);
  const log: Log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dryRun = options.dryRun === true;

  const report: MigrateReport = {
    legacy, target, dryRun, movedSessions: 0, skipped: 0, files: [],
  };

  if (!existsSync(legacy)) {
    log(`旧目录不存在，无需迁移：${legacy}`);
    return report;
  }
  if (legacy === target) {
    log('旧目录与目标相同，跳过');
    return report;
  }

  log(`旧目录：${legacy}`);
  log(`目标：  ${target}`);
  if (dryRun) log('（dry-run：不写任何东西）');

  // ─── sessions / traces ───
  for (const sub of ['sessions', 'traces']) {
    const src = path.join(legacy, sub);
    const dest = path.join(target, sub);
    if (!existsSync(src)) continue;
    if (dryRun) {
      const count = countFiles(src);
      report.movedSessions += count;
      log(`  ${sub}/：将搬 ${count} 个（dry-run）`);
      continue;
    }
    const result = moveFilesInto(src, dest, log);
    report.movedSessions += result.moved;
    report.skipped += result.skipped;
    log(`  ${sub}/：搬了 ${result.moved} 个${result.skipped ? `，跳过 ${result.skipped} 个（已存在）` : ''}`);
    // 搬完把空的旧子目录删掉（只删空的）。
    try {
      if (readdirSync(src).length === 0) rmdirSync(src);
    } catch {
      /* 留着也不影响 */
    }
  }

  // ─── 三个 json ───
  for (const name of ['models.json', 'auth.json', 'settings.json']) {
    const srcFile = path.join(legacy, name);
    const destFile = path.join(target, name);
    if (!existsSync(srcFile)) continue;
    const source = jsonOrNull(srcFile);
    const current = jsonOrNull(destFile);
    if (current === null) {
      // 目标没有 → 直接搬。
      if (!dryRun) {
        mkdirSync(path.dirname(destFile), { recursive: true });
        copyFileSync(srcFile, destFile);
      }
      report.files.push(`${name}：目标缺失，已搬`);
      log(`  ${name}：目标缺失，已搬`);
      continue;
    }
    if (name === 'settings.json') {
      // 两边都有：目标是新的（pi 那边带 lastChangelogVersion），不动。
      report.files.push(`${name}：两边都有，保留目标`);
      log(`  ${name}：两边都有，保留目标`);
      continue;
    }
    const merged =
      name === 'models.json' ? mergeModels(current, source ?? {}) : mergeAuth(current, source ?? {});
    if (!merged.changed) {
      report.files.push(`${name}：无需合并`);
      log(`  ${name}：无需合并`);
      continue;
    }
    if (!dryRun) {
      mkdirSync(path.dirname(destFile), { recursive: true });
      writeFileSync(destFile, `${JSON.stringify(merged.config, null, 2)}\n`, 'utf8');
    }
    report.files.push(`${name}：已合并`);
    log(`  ${name}：已合并（不覆盖目标已有的值）`);
  }

  if (!dryRun) pruneEmptyDirs(path.join(target, 'sessions'));

  // 旧目录空了就可以删了。留着的话没有任何作用，只会让下次误判「没迁过」。
  if (!dryRun) {
    try {
      if (readdirSync(legacy).length === 0) {
        rmdirSync(legacy);
        log(`旧目录已空，删除：${legacy}`);
      } else {
        log(`旧目录还有残留（${readdirSync(legacy).join(', ')}），保留以便人工确认`);
      }
    } catch {
      /* 留着也不影响 */
    }
  }

  return report;
}

// CLI: node --import tsx scripts/migrate-config-dir.ts [--dry-run]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  migrateToPiDir({ dryRun: process.argv.includes('--dry-run') });
}