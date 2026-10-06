/**
 * 配置家目录 —— 本项目**唯一**的全局状态位置。
 *
 * 位置：`~/.redux-agent/`（可用 `REDUX_AGENT_DIR` 搬走）。
 *
 * ## 为什么不叫 `pi-…`
 *
 * 目录里没有一行 pi 的代码，唯一的交集是**布局照抄 pi**（models.json / auth.json /
 * settings.json / sessions/ 这套结构是照着 pi-coding-agent 的 `getAgentDir()` 抄的）。
 * 名字带 `pi` 前缀会让人误以为这里存着 pi 的东西或依赖 pi —— 所以前缀去掉，
 * 「照抄了 pi 的布局」这件事写在注释和 README 里，不写在目录名里。
 *
 * ## 结构
 *
 *     ~/.redux-agent/
 *       models.json            provider / 模型目录（格式与 pi 相同）
 *       auth.json              凭证（格式与 pi 相同；只放 key，baseUrl 在 models.json）
 *       settings.json          默认 provider / model / thinkingLevel
 *       sessions/
 *         --<cwd 编码>--/       按工作目录分（编码规则与 pi 相同）
 *           <sessionId>.jsonl 会话：首行 header，其后每行一条 entry
 *       traces/
 *         <sessionId>.jsonl        轨迹树（一次尝试一节点）+ 装载段（prompt / model）

 *
 * 轨迹单独放 `traces/` 而不是混进 sessions/：轨迹是**每次对话**的产物（一次尝试一节点、
 * 落盘频繁），会话文件是给人看的历史。分开之后「回放一段对话」不必先跳过一堆与它无关
 * 的记录。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_NAME = '.redux-agent';
/** 搬家用目录的环境变量（与 pi 的 `PI_CODING_AGENT_DIR` 同构）。 */
export const ENV_HOME = 'REDUX_AGENT_DIR';

export function configHome(): string {
  const env = process.env[ENV_HOME];
  return env ? path.resolve(env) : path.join(homedir(), CONFIG_DIR_NAME);
}

export function modelsPath(): string {
  return path.join(configHome(), 'models.json');
}

export function authPath(): string {
  return path.join(configHome(), 'auth.json');
}

export function settingsPath(): string {
  return path.join(configHome(), 'settings.json');
}

export function sessionsDir(): string {
  return path.join(configHome(), 'sessions');
}

export function tracesDir(): string {
  return path.join(configHome(), 'traces');
}

/** 缺文件时返回 null，不抛 —— 配置目录可能还没建。 */
export function readJsonIfExists<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new Error(`读 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ─── sessions 路径（编码规则与 pi 相同） ───

/**
 * 工作目录 → 目录名。
 *
 * 规则来自 pi-coding-agent 的 `migrations.js`：`--<cwd 把 / \ : 换成 ->--`。
 * 照抄是为了两边目录长得一样（虽然目前不互通）。
 *
 *     C:\Users\me\proj  →  --C-Users-me-proj--
 */
export function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function sessionDirFor(cwd: string): string {
  return path.join(sessionsDir(), encodeCwd(cwd));
}

export function sessionPath(sessionId: string, cwd: string): string {
  return path.join(sessionDirFor(cwd), `${sessionId}.jsonl`);
}

export function tracePathFor(sessionId: string): string {
  return path.join(tracesDir(), `${sessionId}.jsonl`);
}

// ─── 列会话 ───

/** 一个会话的摘要（列表里显示用；细节要读文件）。 */
export interface SessionSummary {
  id: string;
  /** 会话自己的工作目录（从 header 读，列表阶段不猜）。 */
  cwd: string;
  file: string;
  /** 最后修改时间（ms）。 */
  mtimeMs: number;
  /** 首行 header 里的创建时间（ISO 字符串），读不到就 undefined。 */
  createdAt?: string | undefined;
  /** 消息条数（数文件行数，不解析）。 */
  entries: number;
}

function firstLine(file: string): string | null {
  try {
    const fd = readFileSync(file, 'utf8');
    const nl = fd.indexOf('\n');
    return nl < 0 ? fd : fd.slice(0, nl);
  } catch {
    return null;
  }
}

/** 数**消息**条数（跳过 header）—— 列表里显示「几条」指的是对话多长，不是文件几行。 */
function countLines(file: string): number {
  try {
    const text = readFileSync(file, 'utf8');
    if (text === '') return 0;
    let n = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      // header 那行不算消息。
      if (line.includes('"type":"session"')) continue;
      n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 列出所有会话，按最近修改倒序。
 *
 * 遍历 sessions/ 下的每个 `--<cwd>--` 目录（目录名本身就编码了 cwd，先用它，
 * 读得到 header 就用 header 里的 —— header 更权威）。
 */
export function listSessions(): SessionSummary[] {
  const root = sessionsDir();
  if (!existsSync(root)) return [];

  const out: SessionSummary[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }

  for (const dirName of dirs) {
    const dir = path.join(root, dirName);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // 目录名 `--C-Users-me-proj--` 反推不出原 cwd（有损），所以只当提示用；
    // 真正的 cwd 读 header。
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const line = firstLine(full);
      let cwd = '';
      let createdAt: string | undefined;
      let id = file.replace(/\.jsonl$/, '');
      if (line) {
        try {
          const header = JSON.parse(line) as { type?: string; cwd?: string; id?: string; timestamp?: string };
          if (header.cwd) cwd = header.cwd;
          if (header.id) id = header.id;
          if (header.timestamp) createdAt = header.timestamp;
        } catch {
          // header 坏了也要列出来（用户还能看到它、删掉它），只是拿不到 cwd。
        }
      }
      out.push({ id, cwd, file: full, mtimeMs, createdAt, entries: countLines(full) });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── 清理 ───

/**
 * 清掉一批会话：会话文件 + 对应的轨迹文件。
 *
 * ## 为什么两个都要删
 *
 * 一个会话在盘上落两处：`sessions/<cwd 编码>/<id>.jsonl`（对话历史）与 `traces/<id>.jsonl`
 * （执行轨迹）。只删前者的话，`/api/sessions` 列表干净了，但 `traces/` 会一直攒着
 * 几万个小文件 —— 而且那才是真正占空间的一份。
 *
 * ## 为什么不做「物理删除」之外的软标记
 *
 * 用户点「清理」就是要磁盘真的少下来。留个 .trash 再定期扫是另一套机制，
 * 不如直接删：调用方（Web 的确认弹窗）已经问过用户了。
 *
 * ## 删不掉的怎么办
 *
 * Windows 上文件可能被索引器/编辑器短暂占着。这里**吞掉错误并计数**，
 * 不让一个顽固文件把整批清理炸掉 —— 用户看到「清了 12 个（1 个没删掉）」比看到报错有用。
 */
export interface CleanResult {
  /** 成功删掉的文件数（会话 + 轨迹都算）。 */
  removed: number;
  /** 删掉的会话数。 */
  sessions: number;
  /** 删不掉的：`<id>：<原因>`。 */
  failed: { id: string; reason: string }[];
}

export function cleanSessions(ids: readonly string[]): CleanResult {
  const result: CleanResult = { removed: 0, sessions: 0, failed: [] };
  // 目录名 → 里面的会话 id，避免同一个会话被列两次（listSessions 按目录遍历）。
  const byId = new Map<string, string>();
  for (const session of listSessions()) {
    if (!byId.has(session.id)) byId.set(session.id, session.file);
  }
  for (const id of ids) {
    const file = byId.get(id);
    if (!file) {
      result.failed.push({ id, reason: `找不到会话 ${id}` });
      continue;
    }
    const targets = [file, tracePathFor(id)];
    let ok = true;
    for (const target of targets) {
      try {
        if (existsSync(target)) {
          rmSync(target, { force: true });
          result.removed += 1;
        }
      } catch (error) {
        ok = false;
        result.failed.push({
          id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (ok) result.sessions += 1;
  }
  return result;
}

/**
 * 清掉**不在** `keep` 里的全部会话。
 *
 * 用途是「一键把测试留下的垃圾扫掉」：测试会话的 cwd 全是临时目录，
 * 界面上根本没法一个个点。keep 放行当前正在用的那个 id —— 它正在被记录器写着，
 * 删了会让接下来的消息写进一个已被删掉的文件（Linux 上还会拿到一个「看不见的」句柄）。
 */
export function cleanSessionsExcept(keep: readonly string[]): CleanResult {
  const keepSet = new Set(keep);
  const ids = listSessions()
    .map((s) => s.id)
    .filter((id) => !keepSet.has(id));
  return cleanSessions(ids);
}
