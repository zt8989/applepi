/**
 * 配置家目录 —— 本项目**唯一**的全局状态位置。
 *
 * 位置：默认就是 pi 的 `~/.pi/agent`（见 `configHome()`）。
 *
 * ## 为什么与 pi 同址（而不是自己的 ~/.redux-agent）
 *
 * 之前用 `~/.redux-agent/`，现在**默认与 pi 共用** —— 两边读写同一份 `models.json` /
 * `auth.json` / `settings.json` / `sessions/`。理由是这两个都是配置**一份**就够的东西：
 * provider 目录改一次两边都得知道，key 改一次两边都得用，pi 是官方工具、我们只是另一个
 * 前端。分两个目录的代价是每次改配置都得同步两次，收益仅仅是一个命名上的所有权标记。
 *
 * 环境变量兼容两个（前者优先，因为那是本项目自己的名字）：
 *   - `REDUX_AGENT_DIR`      本项目拼的，给测试隔离用
 *   - `PI_CODING_AGENT_DIR`  pi 的官方名（`getAgentDir()` 也认它）
 *
 * 两个都没设时跟 pi 一样：`~/.pi/agent`。
 *
 * ## 结构（与 pi 一致）
 *
 *     ~/.pi/agent/
 *       models.json            provider / 模型目录
 *       auth.json              凭证（只放 key，baseUrl 在 models.json）
 *       settings.json          默认 provider / model / thinkingLevel
 *       sessions/
 *         --<cwd 编码>--/       按工作目录分（编码规则与 pi 相同）
 *           <sessionId>.jsonl 会话：首行 header，其后每行一条 entry
 *
 * `traces/` 是我们**多出来的**一个目录（pi 没有）：轨迹树（一次尝试一节点）+ 装载段
 * （prompt / model）。它不能混进 sessions/ —— 轨迹是每次对话的产物、落盘频繁，
 * 会话文件是给人看的历史，混在一起「读一个会话」得先跳过一堆与它无关的记录。
 *
 * ## 会话怎么与 pi 互通
 *
 * 目录名（`--<cwd>--` 编码）与 header 形状与 pi 一致，所以 pi 的 `/resume` 能看到我们的
 * 会话，我们的 `/sessions` 也能看到 pi 的。两个已知差异，都不影响读：
 *   - **文件名**：pi 写 `<ISO 时间戳>_<id>.jsonl`，我们写 `<id>.jsonl`。pi 按 header
 *     里的 `id` 识别会话（不是文件名），所以两边都能列出来；反之我们读 pi 的文件时
 *     取 header 的 id，同样不靠文件名（见 `listSessions()`）。
 *   - **version**：我们写 `1`，pi 当前是 `3`。pi 会把 v1 升到 v3（补 `id`/`parentId`
 *     树、把 `hookMessage` 改成 `custom`）并重写文件；那些字段我们写的时候本来就有，
 *     所以升完不会丢东西。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  CONFIG_DIR_NAME as PI_DIR_NAME,
  ENV_AGENT_DIR,
  getAgentDir,
} from '@earendil-works/pi-coding-agent/dist/config.js';

/** pi 自己的配置目录名（`.pi`）。从官方常量拿，不手写字符串。 */
export const PI_CONFIG_DIR: string = PI_DIR_NAME;
/** 本项目的搬家环境变量（测试隔离用）。 */
export const ENV_HOME = 'REDUX_AGENT_DIR';
/** pi 的官方搬家环境变量（与它自己同名同义）。 */
export const ENV_PI_HOME: string = ENV_AGENT_DIR;

/** 旧目录名（迁移脚本 `scripts/migrate-config-dir.ts` 的源）。 */
export const CONFIG_DIR_NAME = '.redux-agent';

/**
 * 配置家目录：**默认与 pi 同址**（`~/.pi/agent`）。
 *
 * 优先级 `REDUX_AGENT_DIR` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`。
 * 认 pi 的那个变量是为了「在 pi 那边搬了目录，这边也跟着走」—— 不然会出现
 * 我们与 pi 各读各的，改了 key 只有一边生效。
 *
 * 早先这里是 `~/.redux-agent`。换到同址是为了让配置只有一份，见文件头的理由。
 */
export function configHome(): string {
  // 优先认本项目自己的变量（测试靠它隔离）；没设就**直接用 pi 的 getAgentDir()**。
  //
  // 为什么不手写 `join(homedir(), '.pi', 'agent')`：那是抄 pi 的实现，而 pi 改了
  // （比如支持 tilde 展开、换目录名）我们就会静默地指向另一个地方 —— 症状是
  // “改了一边另一边读不到”，很难查。现在两者是同一份代码。
  const own = process.env[ENV_HOME];
  if (own) return path.resolve(own);
  return getAgentDir();
}

/**
 * `<家目录>/models.json`。
 *
 * pi 那边有 `getModelsPath()`，但它**不认** `REDUX_AGENT_DIR`（只认自己的
 * `PI_CODING_AGENT_DIR`）。测试要能把自己从真实家目录里摘出去，所以路径仍从
 * `configHome()` 推 —— 只是目录名与文件名与 pi 一致。
 */
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

/** 取一段文本的首行（调用方已经读到的那一截里找）。 */
function firstLineOf(chunk: string): string {
  const nl = chunk.indexOf('\n');
  return nl < 0 ? chunk : chunk.slice(0, nl);
}

/**
 * 数**消息**条数（跳过 header）—— 列表里显示「几条」指的是对话多长，不是文件几行。
 *
 * ## 为什么不整文件读进来再 `split('\n')`
 *
 * 早先那样做，而列表阶段每个会话要读**两次**（一次取 header、一次数条数）：
 * 一个 18MB 的 sessions/ 目录就是 36MB 的读 + 36 万次字符串比较，而这一段在弹窗弹出前
 * 是**同步**的 —— 用户看到的就是「打开 /sessions 要等一分钟」。
 *
 * 现在只读开头 64KB 取 header（见 `readHead`），条数则**分块流式数换行**：
 * 不把全文读进内存，也不建一个几十万元素的 `split` 结果数组。而条数是**精确**的 ——
 * 列表副标题里那个数字用户看得见，不能拿「估个大概」换速度。
 */
function countLines(file: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let newlines = 0;
    let pos = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, pos);
      if (read <= 0) break;
      pos += read;
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 0x0a) newlines += 1;
      }
    }
    // 只数**完整的**行：文件末尾没换行的那半行是崩溃截断的残骸，
    // 读的时候本来也会被跳过（JSON.parse 失败），所以不计。
    // 减 1 是 header 那行，它不是消息。
    return Math.max(0, newlines - 1);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读失败后的清理失败不值得抛。
      }
    }
  }
}

/** 只读文件开头 `bytes` 字节（header 在首行，所以只需要一点）。 */
function readHead(file: string, bytes = 65536): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读失败后的清理失败不值得抛。
      }
    }
  }
}

/**
 * 列出所有会话，按最近修改倒序。
 *
 * 遍历 sessions/ 下的每个 `--<cwd>--` 目录（目录名本身就编码了 cwd，先用它，
 * 读得到 header 就用 header 里的 —— header 更权威）。
 *
 * ## 代价：18MB 的目录要读完一遍，但只扫**字节**
 *
 * header 与条数都来自文件内容（header 给 cwd/createdAt，条数是列表副标题里那个数），
 * 所以这里确实要读一遍全部会话 —— 但读的是**字节**、数的是换行符，不建字符串数组、
 * 不 `JSON.parse`。实测 124 个会话 / 18MB 从 286ms 降到 37ms。
 *
 * 「条数」必须**精确**：它显示给用户看，拿估算换速度是把一个可见的错换成看不见的慢。
 * 真正让弹窗等一分钟的不是这一步（是 `session-picker` 里的标题，见那里的注释），
 * 所以这里保住「精确」而不是去猜。
 */
export function listSessions(): SessionSummary[] {
  const root = sessionsDir();
  if (!existsSync(root)) return [];

  const out: SessionSummary[] = [];
  let dirs: string[];
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
    let files: string[];
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
      const head = readHead(full);
      const line = head === '' ? null : firstLineOf(head);
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
