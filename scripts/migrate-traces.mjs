#!/usr/bin/env node
/**
 * 把旧的项目内 `.trace/` 搬到配置家目录，并重建可恢复的会话。
 *
 * ## 为什么需要它
 *
 * 轨迹原本落在**项目**的 `.trace/` 下，后来搬到了 `~/.redux-agent/traces/`
 * （理由见 src/config-home.ts：轨迹是会话级产物，放项目里会在每个仓库留垃圾、
 * 换个目录就找不到历史）。搬完之后新代码不再看项目里的 `.trace/`，老数据就成了
 * 孤儿 —— 这个脚本把它们捡回来。
 *
 * ## 为什么能重建会话
 *
 * 轨迹文件里除了节点（`add` / `close`）还有 **`message` 记录**（每次 dispatch 时
 * 把新消息追加一行）。所以一份旧轨迹里其实**已经有完整的对话内容**，可以据此
 * 生成 `sessions/<cwd>/<id>.jsonl` —— 于是旧轨迹不只是能看，还能**接着聊**。
 *
 * 反过来不成立：会话文件里没有 attempt 的时间线，重建不出轨迹。
 *
 * ## 用法
 *
 *     npm run trace:migrate                 # 扫当前目录的 .trace/
 *     npm run trace:migrate -- --from DIR   # 扫指定目录（可重复）
 *     npm run trace:migrate -- --dry-run    # 只看会做什么
 *     npm run trace:migrate -- --overwrite  # 已存在的会话文件也重建
 *
 * 默认**不覆盖**已有的会话文件 —— 那可能是用户已经在用的历史。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const paint = (c, s) => (process.env.NO_COLOR ? s : `${c}${s}${RESET}`);

/** 与 src/config-home.ts 保持一致（这里不能 import TS，所以抄一份常量）。 */
function configHome() {
  const env = process.env.REDUX_AGENT_DIR;
  return env ? path.resolve(env) : path.join(homedir(), ".redux-agent");
}

/** 与 src/config-home.ts 的 encodeCwd 同一规则。 */
function encodeCwd(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1]);
  }
  return out;
};

const dryRun = flag("--dry-run");
const overwrite = flag("--overwrite");
const sources = optAll("--from");
if (sources.length === 0) sources.push(process.cwd());

const home = configHome();
const tracesDir = path.join(home, "traces");
const sessionsDir = path.join(home, "sessions");

/**
 * 从轨迹文本里取出 message 记录与工具定义（重建会话用）。
 *
 * 坏行跳过 —— 与回放同一策略：崩溃只会截断最后半行。
 */
function parseTrace(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record.op === "message" && record.message) messages.push(record.message);
  }
  return { messages };
}

/** 会话文件：header + 每条消息一行 entry。格式与 src/session-file.ts 一致。 */
function buildSessionText(id, cwd, messages, timestamp) {
  const header = {
    type: "session",
    version: 1,
    id,
    timestamp: timestamp ?? new Date().toISOString(),
    cwd,
  };
  const lines = [JSON.stringify(header)];
  let parentId = null;
  messages.forEach((message, index) => {
    const entryId = `e${index + 1}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId,
        timestamp: header.timestamp,
        message,
      }),
    );
    parentId = entryId;
  });
  return `${lines.join("\n")}\n`;
}

/** 找一个目录里的轨迹文件（`<id>.jsonl`，排除 `<id>.init.jsonl`）。 */
function findTraces(dir) {
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const ids = new Set();
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    if (name.endsWith(".init.jsonl")) {
      ids.add(name.slice(0, -".init.jsonl".length));
    } else {
      ids.add(name.slice(0, -".jsonl".length));
    }
  }
  const out = [];
  for (const id of ids) {
    const trace = path.join(dir, `${id}.jsonl`);
    const init = path.join(dir, `${id}.init.jsonl`);
    out.push({
      id,
      trace: existsSync(trace) ? trace : null,
      init: existsSync(init) ? init : null,
    });
  }
  return out;
}

// ── 收集要迁的东西 ──

/** 先看家目录里已有的（可能是有轨迹但没会话 —— 那也该重建会话）。 */
const jobs = [];
const seen = new Set();

for (const source of sources) {
  const root = path.resolve(source);
  // 用户可能指到项目根，也可能直接指到 .trace/。
  const dirs = path.basename(root) === ".trace" ? [root] : [path.join(root, ".trace")];
  for (const dir of dirs) {
    for (const found of findTraces(dir)) {
      const key = `${found.id}@${root}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ ...found, cwd: root, from: dir });
    }
  }
}

// 家目录里已有的轨迹（没有对应会话的也要重建）。
for (const found of findTraces(tracesDir)) {
  const key = `${found.id}@home`;
  if (seen.has(key)) continue;
  seen.add(key);
  const sessionFile = path.join(sessionsDir, encodeCwd(process.cwd()), `${found.id}.jsonl`);
  jobs.push({ ...found, cwd: process.cwd(), from: tracesDir, alreadyHome: true, sessionFile });
}

if (jobs.length === 0) {
  process.stdout.write(
    [
      `${paint(BOLD, "没有找到要迁移的轨迹")}`,
      `  找过: ${sources.map((s) => path.join(path.resolve(s), ".trace")).join(", ")}`,
      `        ${tracesDir}`,
      "",
      paint(DIM, "（轨迹是每次对话的产物；没跑过就没数据。用 --from DIR 指定别处。）"),
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ── 执行 ──

const actions = [];
if (!dryRun) mkdirSync(tracesDir, { recursive: true });

for (const job of jobs) {
  // 1. 轨迹文件搬进家目录
  if (!job.alreadyHome) {
    for (const [kind, file] of [
      ["轨迹", job.trace],
      ["装载段", job.init],
    ]) {
      if (!file) continue;
      const dest = path.join(tracesDir, path.basename(file));
      if (existsSync(dest) && !overwrite) {
        actions.push([YELLOW, `跳过 ${kind}（家目录已有）`, path.basename(file)]);
        continue;
      }
      if (!dryRun) copyFileSync(file, dest);
      actions.push([GREEN, `搬入${kind}`, `${file}  →  ${dest}`]);
    }
  }

  // 2. 从 message 记录重建会话
  const traceFile = job.alreadyHome ? job.trace : (job.trace ?? job.init);
  if (!traceFile) continue;
  let text = "";
  try {
    text = readFileSync(traceFile, "utf8");
  } catch {
    actions.push([RED, "读不了轨迹，跳过", traceFile]);
    continue;
  }
  const { messages } = parseTrace(text);
  if (messages.length === 0) {
    actions.push([DIM, `没有消息记录，不建会话`, job.id]);
    continue;
  }

  const sessionFile =
    job.sessionFile ?? path.join(sessionsDir, encodeCwd(job.cwd), `${job.id}.jsonl`);
  if (existsSync(sessionFile) && !overwrite) {
    actions.push([YELLOW, `跳过会话（已存在）`, `${job.id}  ${sessionFile}`]);
    continue;
  }
  if (!dryRun) {
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, buildSessionText(job.id, job.cwd, messages), "utf8");
  }
  actions.push([GREEN, `重建会话（${messages.length} 条消息）`, sessionFile]);
}

process.stdout.write(
  [
    `${paint(BOLD, dryRun ? "迁移预览（--dry-run，没写任何文件）" : "迁移完成")}`,
    `  家目录  ${home}`,
    `  任务    ${jobs.length} 份轨迹`,
    "",
    ...actions.map(([color, label, detail]) => `  ${paint(color, label)}  ${paint(DIM, detail)}`),
    "",
  ].join("\n"),
);
