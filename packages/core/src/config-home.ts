/**
 * 配置家目录 —— 本项目**唯一**的全局状态位置，默认与 pi 共用 `~/.pi/agent`。
 *
 * 与 pi 同址的理由：`models.json` / `auth.json` / `settings.json` / `sessions/` 都是
 * 「配置一份就够」的东西，分两个目录的收益只是一个命名上的所有权标记，代价是每次改配置
 * 都得同步两次。环境变量也只认 pi 的官方名 `PI_CODING_AGENT_DIR`。
 *
 * 结构（与 pi 一致）：
 *
 *     ~/.pi/agent/
 *       models.json            provider / 模型目录
 *       auth.json              凭证（只放 key，baseUrl 在 models.json）
 *       settings.json          默认 provider / model / thinkingLevel
 *       sessions/
 *         --<cwd 编码>--/       按工作目录分（编码规则与 pi 相同）
 *           <时间戳>_<id>.jsonl 会话：首行 header，其后每行一条 entry
 *
 * `traces/` 是本项目**多出来的**一个目录（pi 没有）：轨迹树 + 装载段。它不能混进 sessions/
 * —— 轨迹落盘频繁，混在一起「读一个会话」得先跳过一堆无关记录。
 *
 * 会话互通：目录名、文件名、header 形状、session id 形状（UUIDv7）都与 pi 一致，所以两边
 * 的 `/resume` 互相看得见，也能把 id 粘给对方的 `--session <id>`。header 的 `version` 写
 * 当前 pi 的 `3`，v3 多出来的两样（开头的 `model_change` 与 head system 消息）我们自己写；
 * 老的 v1 文件 pi 仍会自动升，那些字段我们本来就有，升完不会丢东西。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
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
  type SessionEntry,
  type SessionHeader,
  type SessionInfoEntryLike,
} from './session-file';
import { upgradeTraceToV2 } from './trace-store';

/** 末尾读多少字节（找「最后一次说话」）。见 `listSessions` 的表。 */
const TAIL_BYTES = 256 * 1024;

/** pi 自己的配置目录名（`.pi`）。从官方常量拿，不手写字符串。 */
export const PI_CONFIG_DIR: string = PI_DIR_NAME;

/** 旧目录名（迁移脚本 `scripts/migrate-config-dir.ts` 的源）。 */
export const CONFIG_DIR_NAME = '.redux-agent';

/**
 * 配置家目录 —— **就是 pi 的 `getAgentDir()`**（`~/.pi/agent`），只认 pi 那一个环境变量
 * （`PI_CODING_AGENT_DIR`）。本项目不再额外认自己的变量：两个变量指向同一件事、却只有一个
 * 被 pi 认，配置就会分家。
 *
 * 不手写 `join(homedir(), '.pi', 'agent')`：那是抄 pi 的实现，pi 改了（换目录名、支持 tilde）
 * 我们就会静默指向另一个地方，症状是「改了一边另一边读不到」。
 */
export function configHome(): string {
  return getAgentDir();
}

/**
 * `<家目录>/models.json`。路径从 `configHome()` 推（而不是抄 pi 的 `getModelsPath()`），
 * 于是读与写永远落在同一处。
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

/**
 * 某个工作目录的**轨迹**目录：`traces/--<cwd 编码>--/`。
 *
 * 与 sessions/ 同一套编码（`encodeCwd`）、同一个理由：会话与轨迹同生同死，按 cwd
 * 归类后两边目录一一对应 —— 删会话时轨迹就在旁边；跨项目 `/resume` 轨迹也跟着走，
 * 不会把两个项目的树混在一个平目录里。
 */
export function traceDirFor(cwd: string): string {
  return path.join(tracesDir(), encodeCwd(cwd));
}

/** 找不到 cwd 的轨迹去哪：`traces/--unknown--/`。不丢数据，也不散在平目录里。 */
export const TRACE_UNKNOWN_DIR_NAME = '--unknown--';

/** 迁移标记文件：存在即表示平目录已归位，启动不再扫。 */
export function traceMigrateMarkerPath(): string {
  return path.join(configHome(), 'trace_migrate');
}

/** v2 格式迁移的标记文件：存在即表示旧内容已升级，启动不再扫。 */
export function traceV2MigrateMarkerPath(): string {
  return path.join(configHome(), 'trace_v2');
}

/**
 * 一次性的旧轨迹迁移：把平的 `traces/*.jsonl` 按 cwd 归位到 `traces/--<cwd>--/`。
 *
 * 旧布局是平目录（`traces/<时间戳>_<id>.jsonl`），轨迹没有自己的 cwd 字段，归属从
 * 两个来源拼：① 自己的 `prompt.init.sections.cwd`（`<cwd>\n…\n</cwd>` 包着）；
 * ② 同 id 的 sessions 文件头（header 一定有 cwd）。两者都拿不到（多半是只有装载段、
 * 没接过话的空会话）进 `--unknown--/`，不丢数据。
 *
 * 只跑一次：`~/.pi/agent/trace_migrate` 标记文件存在就直接返回。迁移是 rename（同盘
 * 原子），不是复制 —— 中途崩了最坏留下半个目录，下次启动标记没写就再跑一遍。
 *
 * @returns 迁移摘要；标记已存在时返回 null（什么都没做）。
 */
export function migrateFlatTraces(): TraceMigrationResult | null {
  const marker = traceMigrateMarkerPath();
  if (existsSync(marker)) return null;

  const root = tracesDir();
  const result: TraceMigrationResult = { moved: 0, unknown: 0, failed: [] };

  // 平目录里的文件：只拿**文件**，`--<cwd>--/` 子目录（新布局已在用）不碰。
  let flat: string[];
  try {
    flat = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);
  } catch {
    // 目录不存在 = 全新安装，直接写标记收工。
    writeFileSync(marker, `${new Date().toISOString()} nothing to migrate\n`, 'utf8');
    return result;
  }

  // id -> cwd，来源②：同 id 的 sessions 文件头。
  const id2cwd = new Map<string, string>();
  const sessionsRoot = sessionsDir();
  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    sessionDirs = [];
  }
  for (const dir of sessionDirs) {
    const full = path.join(sessionsRoot, dir);
    let names: string[] = [];
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = sessionIdFromFileName(name);
      if (id2cwd.has(id)) continue;
      try {
        const header = JSON.parse(readFileSync(path.join(full, name), 'utf8')) as {
          cwd?: unknown;
        };
        if (typeof header.cwd === 'string' && header.cwd !== '') {
          id2cwd.set(id, header.cwd);
        }
      } catch {
        // 坏 header 不挡迁移：这个 id 落到 unknown 而已。
      }
    }
  }

  const unknownDir = path.join(root, TRACE_UNKNOWN_DIR_NAME);
  for (const name of flat) {
    const file = path.join(root, name);
    const id = sessionIdFromFileName(name);
    let cwd = id2cwd.get(id);
    if (cwd === undefined) {
      // 来源①：自己的 prompt.init.sections.cwd（`<cwd>\n…\n</cwd>` 包着）。
      cwd = cwdFromTraceFile(file);
    }
    const target = path.join(
      cwd ? traceDirFor(cwd) : unknownDir,
      name,
    );
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      // rename 而不是 copy+delete：同盘原子，不留半份。
      renameSync(file, target);
      if (cwd) {
        result.moved += 1;
      } else {
        result.unknown += 1;
      }
    } catch (error) {
      result.failed.push({
        file: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    mkdirSync(configHome(), { recursive: true });
    writeFileSync(
      marker,
      `${new Date().toISOString()} moved=${result.moved} unknown=${result.unknown} failed=${result.failed.length}\n`,
      'utf8',
    );
  } catch {
    // 标记写不出来（只读目录？）：下次启动会再跑一遍，rename 过的文件已经不在平目录，
    // 幂等。
  }
  return result;
}

/**
 * 从轨迹文件里抽 cwd：第一条 `prompt.init` 的 `sections.cwd` 是 `<cwd>\n<路径>\n</cwd>`。
 * 没有 sections（老版本）或没有 prompt.init 返回 null。只读到命中为止，不整文件扫。
 */
function cwdFromTraceFile(file: string): string | undefined {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 512 * 1024);
    for (const line of head.split('\n')) {
      if (!line.includes('"prompt.init"')) continue;
      const record = JSON.parse(line) as { sections?: { cwd?: string } };
      const raw = record.sections?.cwd ?? '';
      const match = /<cwd>\n([\s\S]*?)\n<\/cwd>/.exec(raw);
      if (match) return match[1];
      return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** `migrateFlatTraces()` 的结果。 */
export interface TraceMigrationResult {
  /** 有 cwd、归进了对应项目目录的文件数。 */
  moved: number;
  /** 没有 cwd 线索、进 `--unknown--/` 的文件数。 */
  unknown: number;
  /** rename 失败的（权限 / 被占用）。 */
  failed: { file: string; reason: string }[];
}

/** `migrateTracesV2()` 的结果。 */
export interface TraceV2MigrationResult {
  /** 从 v1 升级到 v2 的文件数。 */
  upgraded: number;
  /** 本来就是 v2、没动的文件数。 */
  skipped: number;
  /** 升级失败的（读/写/替换）。文件保持原样，下次手动删标记还能重试。 */
  failed: { file: string; reason: string }[];
}

/**
 * 一次性的 v1 → v2 内容迁移（用户可见的格式升级，见 trace-store 的 `upgradeTraceToV2`）。
 *
 * v1：无版本头、节点 id 是 `n7`、树上允许多棵根；v2：首行版本头、每行带 `seq`（严格等于
 * 行号，后续分页取数用）、节点 id 是内容 hash、全树单根（system prompt）。
 *
 * 只跑一次：`~/.pi/agent/trace_v2` 标记文件存在就直接返回。逐文件替换是原子的
 * （临时文件 + rename）：中途崩了最坏留下一个没升级的文件，删掉标记重跑即可。
 *
 * 必须在 `migrateFlatTraces()` **之后**调：它扫的是 `--<cwd>--/` 新目录布局。
 *
 * @returns 迁移摘要；标记已存在时返回 null（什么都没做）。
 */
export function migrateTracesV2(): TraceV2MigrationResult | null {
  const marker = traceV2MigrateMarkerPath();
  if (existsSync(marker)) return null;

  const root = tracesDir();
  const result: TraceV2MigrationResult = { upgraded: 0, skipped: 0, failed: [] };

  // 只扫子目录（`--<cwd>--/` 与 `--unknown--/`）；平目录里的残留归 migrateFlatTraces 管。
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // 目录不存在 = 全新安装，直接写标记收工。
    writeMarkerV2(result);
    return result;
  }

  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      // `.init.jsonl` 不是轨迹树（见 trace-file 的 listTraceSessionIds 同一过滤器）。
      if (!name.endsWith('.jsonl') || name.endsWith('.init.jsonl')) continue;
      const file = path.join(root, dir, name);
      try {
        // 廉价预检：首行已声明 v2 的直接跳过，不整文件读。
        const head = readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
        try {
          const firstLine = JSON.parse(head) as { v?: unknown };
          if (firstLine && firstLine.v === 2) {
            result.skipped += 1;
            continue;
          }
        } catch {
          // 首行不是合法 JSON（空文件 / 截断）：交给升级函数按坏行丢弃的同一口径处理。
        }
        const upgraded = upgradeTraceToV2(readFileSync(file, 'utf8'));
        if (!upgraded.upgraded) {
          result.skipped += 1;
          continue;
        }
        // 原子替换：写临时文件再 rename，中途崩了不损原文件。
        const tmp = `${file}.migrating`;
        writeFileSync(tmp, upgraded.text, 'utf8');
        renameSync(tmp, file);
        result.upgraded += 1;
      } catch (error) {
        result.failed.push({
          file: `${dir}/${name}`,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  writeMarkerV2(result);
  return result;
}

function writeMarkerV2(result: TraceV2MigrationResult): void {
  try {
    mkdirSync(configHome(), { recursive: true });
    writeFileSync(
      traceV2MigrateMarkerPath(),
      `${new Date().toISOString()} upgraded=${result.upgraded} skipped=${result.skipped} failed=${result.failed.length}\n`,
      'utf8',
    );
  } catch {
    // 标记写不出来（只读目录？）：下次启动会再跑一遍；升级是按版本号幂等的。
  }
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


/**
 * 工作目录 → 目录名：`--<cwd 把 / \ : 换成 ->--`（规则照抄 pi 的 `migrations.js`，
 * 为了两边目录长得一样）：`C:\Users\me\proj` → `--C-Users-me-proj--`。
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

export function tracePathFor(sessionId: string, cwd?: string): string {
  return path.join(traceDirFor(cwd ?? process.cwd()), `${sessionId}.jsonl`);
}

/**
 * 生成文件名里的时间戳部分（与 pi 同一规则）：`2026-10-12T05:44:28.468Z` →
 * `2026-10-12T05-44-28-468Z`。`:` 与 `.` 都要换：Windows 文件名不允许冒号，点号会与
 * 扩展名混淆。
 */
export function fileTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

/** 会话文件名：`<时间戳>_<id>.jsonl`。`timestamp` 建议传 `new Date().toISOString()`。 */
export function sessionFileName(sessionId: string, timestamp: string = new Date().toISOString()): string {
  return `${fileTimestamp(timestamp)}_${sessionId}.jsonl`;
}

/** 轨迹文件名：与会话同一个形状（同一次会话两份记录文件名只差目录）。 */
export function traceFileName(sessionId: string, timestamp: string = new Date().toISOString()): string {
  return `${fileTimestamp(timestamp)}_${sessionId}.jsonl`;
}

/** 从文件名里取出 id 部分（`<时间戳>_<id>.jsonl` → id；没有前缀时原样返回文件名主体）。 */
export function sessionIdFromFileName(fileName: string): string {
  const base = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : fileName;
  const underscore = base.indexOf('_');
  return underscore < 0 ? base : base.slice(underscore + 1);
}

/**
 * 在目录里按下 id 找文件：`<任意时间戳>_<id>.jsonl` 或旧的 `<id>.jsonl`。
 *
 * 必须扫目录而不是拼路径：文件名带创建时刻，而恢复/续写时我们不知道当初那个时刻 ——
 * 只有比 `_<id>.jsonl` 后缀才找得到。旧的 `<id>.jsonl`（改名之前建的）仍然认，作为最后
 * 一条回退。找不到返回 null（调用方决定是「没有这个文件」还是拼一个默认路径）。
 */
export function findFileById(dir: string, id: string): string | null {
  if (id === '') return null;
  // 旧形状先试：它是最廉价的一次 existsSync，且避免为老会话白白 readdir。
  const legacy = path.join(dir, `${id}.jsonl`);
  if (existsSync(legacy)) return legacy;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `_${id}.jsonl`;
  // 多个候选（同一 id 在不同时刻被建过文件，理论上不该发生）取**文件名最大的** ——
  // 时间戳是定长 ISO，字符串序就是时间序，于是拿到的是最新那个。
  let best: string | null = null;
  for (const file of files) {
    if (!file.endsWith(suffix)) continue;
    if (best === null || file > best) best = file;
  }
  return best === null ? null : path.join(dir, best);
}

/** 会话文件的实际路径：先按 id 扫目录（认新名与旧名），找不到就用旧形状拼一个。 */
export function findSessionFile(sessionId: string, cwd: string): string {
  return findFileById(sessionDirFor(cwd), sessionId) ?? sessionPath(sessionId, cwd);
}

/**
 * **只知道 id** 时找会话文件：扫 `sessions/` 下每个 `--<cwd>--` 目录。
 *
 * 「按 cwd + id」不够用：resume 一个别的项目里的会话时，内核的 cwd 还是启动那个，于是按
 * cwd 拼出来的路径指向空目录，而文件在它原本那个项目里（症状：「完整历史」写着「还没落盘」，
 * 可文件明明在）。代价是每个目录一次 `existsSync`，而调用点是「人点开一页」的频率。
 */
export function findSessionFileById(sessionId: string): string | null {
  if (sessionId === '') return null;
  const root = sessionsDir();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const full = path.join(root, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = findFileById(full, sessionId);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 轨迹文件的实际路径：在 cwd 对应的子目录里按 id 扫，找不到就拼新形状。
 * 旧平布局由 `migrateFlatTraces()` 启动时一次性归位，这里不扫平目录。
 */
export function findTraceFile(sessionId: string, cwd?: string): string {
  const scoped = traceDirFor(cwd ?? process.cwd());
  return findFileById(scoped, sessionId) ?? tracePathFor(sessionId, cwd);
}

/**
 * 退出时提示的「怎么恢复这次会话」命令：`ela --session <id>` —— 本项目自己的入口。
 * 两边会话文件完全互通（目录名、文件名、header、id 全一致），粘给 `pi` 也能恢复，
 * 只是那不是我们要提示的默认路径。
 *
 * 只有「**真的落过盘**」才打印（那条命令要能真的跑起来）：非 TTY（管道/重定向）时没人看；
 * 没接过话时那个 id 还没文件，打印出来是误导。
 *
 * @returns 要打印的那一行，或者 null（不该打印）。
 */
export function resumeCommand(sessionId: string | undefined, cwd: string): string | null {
  if (!sessionId) return null;
  if (!process.stdout.isTTY) return null;
  if (!existsSync(findFileById(sessionDirFor(cwd), sessionId) ?? '')) return null;
  return `ela --session ${sessionId}`;
}


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
  /**
   * **第一条 user 消息**（压成一行，见 `firstMessageText`）。没有就 undefined。
   *
   * 只能在这一遍读里拿：pi v3 的 head 本身就有 ~64KB，用户的第一句话紧跟在它后面 ——
   * 另一处再按 64KB 去扫正好扫不到（症状：列表里那一行显示成一串 uuid）。
   */
  firstMessage?: string | undefined;
  /** 分叉来源（header 的 `parentSession`）。本项目还没接 fork，所以通常 undefined。 */
  parentSession?: string | undefined;
/**
 * **最后一次说话**的时间（ms）。与 `mtimeMs` 不是一回事：文件 mtime 会被任何写入改动，
 * 而这条是「最后一次 user/assistant 消息」。排序与「2 小时前」用它，读不到退回 `mtimeMs`。
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
 * 数**消息**条数（跳过 header）—— 列表里那个「几条」指对话多长，不是文件几行。
 *
 * 分块流式数换行：不把全文读进内存，也不建一个几十万元素的 `split` 数组（那正是
 * 「打开 /resume 要等一分钟」的来源）。条数必须**精确**，列表副标题里用户看得见。
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
 * 遍历 sessions/ 下每个 `--<cwd>--` 目录（目录名已编码 cwd，读得到 header 就用 header 的）。
 * 为了「打开列表不读全文」：
 * | 字段 | 怎么拿 |
 * | --- | --- |
 * | header（cwd / id / 时间） | 只读开头 64KB（`readHead`） |
 * | 条数 | 分块流式数换行（`countLines`），精确且不建大数组 |
 * | 名字 / 分叉来源 | 从头扫 512KB、**不提前停**（`readJsonlHead`，见 `readSessionMeta`） |
 * | 最后说话时间 | 只读**末尾** 256KB（`readJsonlTail`） |
 *
 * 全文只在**搜索**里才需要，列表不需要 —— 标题用前几行的第一条 user 消息，时间用末尾。
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
      let id = sessionIdFromFileName(file);
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
        // header 里的分叉来源要单独带上：`readSessionMeta` **读不到它**（它走 `readJsonlHead`，
        // 而那里把 `session` 那一行当 header 拿走了，不进 `content`）。子会话（子代理那些）靠它
        // 从列表里排掉。
        ...(parentSession !== undefined ? { parentSession } : {}),
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
 * **不能**命中就停：pi 的语义是**最后一条** `session_info` 说了算，而改名会反复发生 ——
 * 「命中就停」读到的是第一次那个名字（症状：刚改完名，按 ctrl+n 只看到旧名字）。
 * 改名也可能追加在文件末尾，所以这里限「前 512KB 里的最后一条」：对**正在聊**的会话改名
 * （面板的主要用途）一定命中，对很长的老会话可能读不到。
 */
function readSessionMeta(
  file: string,
): { name?: string; parentSession?: string; firstMessage?: string } | undefined {
  // 不给 `stopAfter`：见上面的「为什么不能提前停」。
  const { content } = readJsonlHead(file, 512 * 1024);
  // 顺带取**第一条 user 消息**：调用方要拿它当标题（列表那一行、`/resume` 面板）。
  // 它必须借用这一遍读 —— 窗口是 512KB，而单独再去读 64KB 会落在 head（~64KB）里，
  // 正好漏掉紧跟其后的第一句话。
  const firstMessage = firstUserMessageText(content);
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
  // 一个都没取到就返回 undefined，调用方于是不写这几个字段。
  return name === undefined && parentSession === undefined && firstMessage === undefined
    ? undefined
    : {
        ...(name !== undefined ? { name } : {}),
        ...(parentSession !== undefined ? { parentSession } : {}),
        ...(firstMessage !== undefined ? { firstMessage } : {}),
      };
}

/**
 * 会话里的**第一条 user 消息**，压成一行（控制字符与连续空白都折成单个空格）。
 *
 * 折成一行是刻意的：它会被塞进侧边栏那一行，一个换行会把排版拆坏。纯附件（只有图片）
 * 的那条跳过 —— 拿一个空标题不如用后面那句。
 */
function firstUserMessageText(entries: readonly SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry?.type !== 'message') continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (message?.role !== 'user') continue;
    const text = oneLine(messageText(message.content));
    if (text !== '') return text;
  }
  return undefined;
}

/** 消息内容（字符串 / 内容块数组）→ 纯文本。图片块给一个占位，别的块跳过。 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join(' ');
}

/** 控制字符与连续空白折成一个空格（标题要一行）。 */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 一个会话当前的显示名（`session_info`）。没起过名（或文件不存在）就 undefined。
 *
 * 与列表里 `SessionSummary.name` 同一份数据、同一套语义；这里只是给「只知道文件路径」的
 * 调用方（`/name`、`/session`）一个直接入口。**只扫前 512KB**（理由见 `readSessionMeta`）。
 */
export function readSessionName(file: string | undefined): string | undefined {
  if (file === undefined || !existsSync(file)) return undefined;
  return readSessionMeta(file)?.name;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}


/**
 * 清掉一批会话：会话文件 + 对应的轨迹文件。
 *
 * 两个都要删：一个会话在盘上落两处（`sessions/` 与 `traces/`），只删前者的话 `traces/`
 * 会一直攒着几万个小文件，而那才是真正占空间的一份。
 *
 * 不做 `.trash` 之类的软标记：用户点「清理」就是要磁盘真的少下来。
 * 删不掉的（Windows 上被索引器/编辑器占着）**吞掉错误并计数**，不让一个顽固文件把整批
 * 清理炸掉 —— 「清了 12 个（1 个没删掉）」比报错有用。
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
  // 目录名 → 会话 id → cwd（轨迹目录按它编码），避免同一个会话被列两次。
  const byId = new Map<string, { file: string; cwd?: string }>();
  for (const session of listSessions()) {
    if (!byId.has(session.id)) byId.set(session.id, { file: session.file, cwd: session.cwd });
  }
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) {
      result.failed.push({ id, reason: `找不到会话 ${id}` });
      continue;
    }
    const targets = [entry.file, findTraceFile(id, entry.cwd)];
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
 * 用途是「一键扫掉测试留下的垃圾」：测试会话的 cwd 全是临时目录，界面上没法一个个点。
 * `keep` 放行当前正在用的那个 id —— 它正被记录器写着，删了会让接下来的消息写进一个已被
 * 删掉的文件。现在没有命令入口（pi 的删历史在 `/resume` 面板里），函数留着是给测试与
 * 将来的 CLI 清理入口用。
 */
export function cleanSessionsExcept(keep: readonly string[]): CleanResult {
  const keepSet = new Set(keep);
  const ids = listSessions()
    .map((s) => s.id)
    .filter((id) => !keepSet.has(id));
  return cleanSessions(ids);
}
