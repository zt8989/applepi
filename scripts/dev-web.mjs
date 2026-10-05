#!/usr/bin/env node
/**
 * 开发模式：一条命令起两个进程。
 *
 *   内核  5274  src/serve.ts --dev   （API + SSE）
 *   vite  5273  web/vite.config.ts   （页面，/api 反代到 5274）
 *
 * 浏览器开 http://localhost:5273 —— 只需要跟 vite 说话，内核在后面。
 *
 * 为什么要这个脚本：`npm run web` 单独跑只能开 vite，页面能加载但所有 /api 都会
 * 失败（内核没起）；`npm run serve` 单独跑只有 API 没有页面。开发要的是两个都活着，
 * 而 npm 本身没有「并��跑两条命令并在任一退出时收掉另一个」的能力。
 *
 * 端口都问 OS（--port 0），横幅打印实际绑到的那个 —— 端口被占用时不会静默失败。
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import process from "node:process";

const KERNEL_PORT = Number(process.env.HARNESS_KERNEL_PORT ?? 5274);
const WEB_PORT = Number(process.env.HARNESS_WEB_PORT ?? 5273);

const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const CYAN = "[36m";
const RESET = "[0m";
const paint = (code, s) => (process.env.NO_COLOR ? s : `${code}${s}${RESET}`);

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300).unref();
}

/** 起一个子进程，标签打在每行前面，两个进程的输出不会糊在一起。 */
function start(label, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  const write = (stream) => (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      stream.write(`${paint(DIM, `[${label}]`)} ${line}\n`);
    }
  };
  child.stdout.on("data", write(process.stdout));
  child.stderr.on("data", write(process.stderr));
  child.on("exit", (code) => {
    if (shuttingDown) return;
    process.stderr.write(
      `${paint(RED, `[${label}] 退出了（code ${code}）`)}\n` +
        `${paint(DIM, "另一个进程也一并停掉。修好再跑 npm run web:dev。")}\n`,
    );
    shutdown(code ?? 1);
  });
  child.on("error", (error) => {
    process.stderr.write(`${paint(RED, `[${label}] 起不来：${error.message}`)}\n`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`等 ${port} 超时（${timeoutMs / 1000}s）`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 内核用 --dev（让开 5273），端口钉死 —— vite 的代理目标要确定。
start("kernel", "node", ["--env-file-if-exists=.env", "--import", "tsx", "src/serve.ts", "--dev", "--port", String(KERNEL_PORT)]);
// vite 钉在 WEB_PORT，与 web/vite.config.ts 的 strictPort 一致。
start("vite", "npx", ["vite", "--config", "web/vite.config.ts", "--port", String(WEB_PORT), "--strictPort"]);

try {
  await waitForPort(KERNEL_PORT);
  process.stdout.write(
    [
      "",
      `${paint(BOLD, "开发模式已就绪")}`,
      `  页面（浏览器开这个）  ${paint(CYAN, `http://localhost:${WEB_PORT}`)}`,
      `  内核 API / SSE       http://localhost:${KERNEL_PORT}/api/...  ${paint(DIM, "（页面同源，浏览器只用 5273）")}`,
      `  ${paint(DIM, "改 web/src 立刻生效；改 src/ 要重跑这个命令。")}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`${paint(RED, String(error.message))}\n`);
  shutdown(1);
}
