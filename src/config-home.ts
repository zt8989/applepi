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
 * 环境变量只认 pi 的官方名 `PI_CODING_AGENT_DIR`（`getAgentDir()` 自己认它）。
 *
 * ## 为什么不自己再认一个
 *
 * 之前本项目额外认了 `REDUX_AGENT_DIR`（优先级更高，给测试隔离用）。现在删掉：
 * 两个变量指向同一件事，却只有 pi 那个会被 pi 自己认 —— 于是会出现「我们以为在家目录 A，
 * pi 在家目录 B」，配置分家。**只有一个环境变量**时不可能分家。测试改用
 * `PI_CODING_AGENT_DIR`（同一个机制、不同名字），隔离效果一样。
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
  getAgentDir,
} from '@earendil-works/pi-coding-agent/dist/config.js';
import {
  readJsonlHead,
  readJsonlTail,
  type SessionHeader,
  type SessionInfoEntryLike,
} from './session-file';

/** 末尾读多少字节（找「最后一次说话」）。见 `listSessions` 的表。 */
const TAIL_BYTES = 256 * 1024;

/** pi 自己的配置目录名（`.pi`）。从官方常量拿，不手写字符串。 */
export const PI_CONFIG_DIR: string = PI_DIR_NAME;

/** 旧目录名（迁移脚本 `scripts/migrate-config-dir.ts` 的源）。 */
export const CONFIG_DIR_NAME = '.redux-agent';

/**
 * 配置家目录 —— **就是 pi 的 `getAgentDir()`**（`~/.pi/agent`）。
 *
 * 本项目只认 pi 那一个环境变量（`PI_CODING_AGENT_DIR`），与 pi 完全同步。
 * 早先这里是 `~/.redux-agent`，再早还额外认了 `REDUX_AGENT_DIR` 且优先级更高 ——
 * 都删了，理由见文件头：「两个变量指向同一件事，却只有一个被 pi 认」。
 *
 * 为什么不手写 `join(homedir(), '.pi', 'agent')`：那是抄 pi 的实现，而 pi 改了
 * （比如支持 tilde 展开、换目录名）我们就会静默地指向另一个地方 —— 症状是
 * “改了一边另一边读不到”，很难查。直接用官方函数，两者不可能分家。
 */
export function configHome(): string {
  return getAgentDir();
}

/**
 * `<家目录>/models.json`。
 *
 * pi 那边有 `getModelsPath()`，我们仍然自己拼 —— 目录名与文件名要与它一致，
 * 但路径从 `configHome()` 推，这样万一将来 pi 加了别的优先级，我们的读与写
 * 仍然落在同一处（而不是一个用官方、一个用自己）。
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
  /** 用户给会话起的名字（`session_info` entry）。没起过就 undefined。 */
  name?: string | undefined;
  /** 分叉来源（header 的 `parentSession`）。本项目还没接 fork，所以通常 undefined。 */
  parentSession?: string | undefined;
  /**
   * **最后一次说话**的时间（ms）。
   *
   * 与 `mtimeMs` 的差别不是「精确一点」而是**另一个东西**：文件 mtime 会被任何写入改动
   * （连改名都算），而这条是「最后一次 user/assistant 消息」。排序与「2 小时前」用它。
   * 读不到就退回 `mtimeMs`。
   */
  lastActivityMs: number;
}

/** cwd 归一化（比大小写、去掉尾部分隔符）——「这条会话是不是当前目录的」就靠它。 */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim().replace(/[/\\]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
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
 * 列出所有会话，按**最后说话**的时间倒序。
 *
 * 遍历 sessions/ 下的每个 `--<cwd>--` 目录（目录名本身就编码了 cwd，先用它，
 * 读得到 header 就用 header 里的 —— header 更权威）。
 *
 * ## 代价：18MB 的目录要扫两遍，但都只扫**字节**
 *
 * | 字段 | 怎么拿 | 为什么 |
 * | --- | --- | --- |
 * | header（cwd / id / 时间） | 只读开头 64KB（`readHead`） | header 是首行，永远在这截里 |
 * | 条数 | 分块流式数换行（`countLines`） | 精确；不把全文读进内存 |
 * | 名字 / 分叉来源 | 从头扫 512KB，**不提前停**（`readJsonlHead`，见 `readSessionMeta`） | `session_info` 可以追加在**任何**位置 —— 给三个月前的会话改名，那条 entry 就在文件末尾 |
 * | 最后说话时间 | 只读**末尾** 256KB（`readJsonlTail`） | 消息 timestamp 在每行里，但最后那次几乎总在末尾 |
 *
 * 早先这里是「每个会话都 `readSession` 整份再 parse 一遍」：124 个会话、18MB 的目录，
 * 光列列表就要 524ms。现在整条弹窗路径 128ms（见 docs/architecture/sessions.md）。
 *
 * ## 为什么**不**扫全文
 *
 * 「全文」只在**搜索**里才需要（找当时聊过的那句话）。而列表本身不需要 —— 显示标题用
 * 第一条 user 消息（也在文件前几行），显示时间用末尾。所以这里坚持「为显示不读全文」。
 * 搜索那侧仍只搜**头部**（见 `session-picker.ts` 的说明），两边的取舍写在同一处。
 */
export function listSessions(filter?: { cwd?: string }): SessionSummary[] {
  const root = sessionsDir();
  if (!existsSync(root)) return [];

  const out: SessionSummary[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }

  // 作用域过滤（pi 的 `Current Folder` / `All`）：cwd 缺失的会话（坏 header）在
  // 「当前目录」下**算作不属于** —— 它可能是任何目录的会话，而界面无法确认。
  // 那一行仍然列在 `All` 里，用户还能看到它、删掉它。
  const wanted = filter?.cwd !== undefined ? normalizeCwd(filter.cwd) : undefined;

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
      let parentSession: string | undefined;
      let id = file.replace(/\.jsonl$/, '');
      if (line) {
        try {
          const header = JSON.parse(line) as {
            type?: string;
            cwd?: string;
            id?: string;
            timestamp?: string;
            parentSession?: string;
          };
          if (header.cwd) cwd = header.cwd;
          if (header.id) id = header.id;
          if (header.timestamp) createdAt = header.timestamp;
          if (header.parentSession) parentSession = header.parentSession;
        } catch {
          // header 坏了也要列出来（用户还能看到它、删掉它），只是拿不到 cwd。
        }
      }
      if (wanted !== undefined && normalizeCwd(cwd) !== wanted) continue;
      out.push({
        id,
        cwd,
        file: full,
        mtimeMs,
        createdAt,
        entries: countLines(full),
        ...(readSessionMeta(full) ?? {}),
        lastActivityMs: readJsonlTail(full, TAIL_BYTES).lastActivityMs || mtimeMs,
      });
    }
  }

  // 按最后说话时间倒序；一样新时用 mtime 兜底（那个会话可能还没写 message entry，
  // 例如只有 init 段 —— 于是 lastActivityMs 是 0）。
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs || b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * 把 `session_info`（名字）与分叉来源读出来。两个都没取到就返回 undefined。
 *
 * ## 为什么**不能** `stopAfter` 命中就停
 *
 * 直觉上「命中 `session_info` 就停」像是对的那个省法（`sessionTitleFromHead` 就是那么做的）。
 * 它是错的：pi 的语义是**最后一条** `session_info` 说了算，而改名是**反复**发生的 ——
 * 给同一个会话改两次名，就有两条。于是「命中就停」读到的是**第一次**的名字，
 * 而用户在 pi 那边看到的是第二次那个。症状是「刚改完名，按 ctrl+n 只看到旧名字」，
 * 而且只在该会话被改过名时出现 —— 极难归因。
 *
 * 更根本的是：一条 entry 可能追加在**文件末尾**（给一个三个月前的会话改名），
 * 所以这里的 512KB 截断本来就不是「读全部」—— 它只是「前 512KB 里的最后一条
 * `session_info`」。对一个**很长**的会话，被改名的那条落在窗口外，仍会读不到。
 *
 * ## 那能不能精确地做
 *
 * 能，但代价是扫全文（名字可能在任意一行），而 docs/architecture/sessions.md 已经为
 * 「不扫全文」付出过代价。所以这里明确选「扫前 512KB」，并把这条限制写在上面。
 * 对**当前**正在聊的会话改名（正是面板的主要用途），那条 entry 就在前几 KB 里，一定命中。
 */
function readSessionMeta(file: string): { name?: string; parentSession?: string } | undefined {
  // 不给 `stopAfter`：见上面的「为什么不能提前停」。
  const { content } = readJsonlHead(file, 512 * 1024);
  // pi 的语义：**最后一条** `session_info` 说了算，且空串 = 显式清名。
  //
  // `name === undefined` **不能**直接当「还没找到」的哨兵 —— 因为空串那条会让它重新变回
  // undefined，于是循环继续往回找，把上一个名字捞出来。那正是「清名之后又冒出旧名字」。
  // 所以另用一个 `seen` 标记区分「没找到」与「找到了，但是空的」。
  let name: string | undefined;
  let nameSeen = false;
  let parentSession: string | undefined;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const entry = content[i];
    if (entry?.type === 'session_info' && !nameSeen) {
      nameSeen = true;
      // 空串 = 显式清掉上一个名字（pi 的 `getSessionName()` 同一语义）。
      const trimmed = (entry as SessionInfoEntryLike).name?.trim();
      name = trimmed === undefined || trimmed === '' ? undefined : trimmed;
    }
    if (parentSession === undefined && entry?.type === 'session') {
      // 走 `SessionHeader` 而不是 `entry.parentSession`：后者在本项目里是
      // `[key: string]: unknown` 的索引签名，拿到的是 `{}`（而 SessionInfoEntryLike
      // 把它遮成 `string | undefined`）。父分叉来自 header，直接读那个形状。
      const fromHeader = (entry as unknown as SessionHeader).parentSession;
      if (fromHeader !== undefined && fromHeader !== '') parentSession = fromHeader;
    }
  }
  // 空名字 = 没取到；两者都没取到就返回 undefined，调用方于是不写这两个字段。
  return name === undefined && parentSession === undefined
    ? undefined
    : { ...(name !== undefined ? { name } : {}), ...(parentSession !== undefined ? { parentSession } : {}) };
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
