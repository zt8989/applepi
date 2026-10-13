import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCwd, sessionFileName } from '../src/config-home';

/**
 * 退出时那行恢复提示：**`Ctrl+C` 与 `Ctrl+D` 都要打**。
 *
 * ```text
 * To resume this session: ela --session <id>
 * ```
 *
 * ## 为什么必须用真 pty 测
 *
 * `resumeCommand()`（`config-home.ts`）的第一道判断就是 `process.stdout.isTTY` ——
 * 管道/重定向一律返回 null。而仓库里其余启动类测试（`tui-startup.test.ts`）都是
 * `stdio: 'pipe'`，于是**这一行永远测不到**：不管是哪个退出分支忘了打，还是
 * `tui.stop()` / `printResumeOnExit()` 的次序被写反（那个坑真踩过，见 9694557），
 * 它们都照样绿。
 *
 * ## 为什么是 expect 而不是 script
 *
 * macOS 的 `script` 会对自己的 stdin 做 `tcgetattr`，而 Node 的 `child_process` 给
 * stdio 管道用的是 **socketpair** —— 于是它报
 * `tcgetattr/ioctl: Operation not supported on socket` 当场退出（Python 的
 * `subprocess.PIPE` 是真 pipe，所以那边能跑）。`expect` 自带 pty、自带「等某段输出
 * 再发键」，不必自己造 pty，也省掉轮询首帧。
 *
 * expect 不是到处都有（Linux 常要另装），没有就跳过 —— 那是环境缺工具，不是代码错。
 *
 * ## 为什么要先有一个会话文件
 *
 * 空会话不落盘（`SessionWriter` 把 header 推迟到第一条消息），这时
 * `resumeCommand()` 按设计**不打** —— 那行命令粘回去会找不到文件。所以这里预置一个
 * 「有话说过的」会话文件，只验「有文件时两个退出键都要打」。
 *
 * 预置文件而不是真聊一句：聊一句要打网络（真 provider）或造一个假 provider 的 SSE
 * （更绕）。退出提示只依赖「文件在不在」，与消息怎么来的无关。
 */

/** 项目根目录（从本文件位置推）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** expect 在不在 —— 不在就跳过（不报失败）。 */
const HAS_EXPECT = spawnSync('expect', ['-v'], { stdio: 'ignore' }).error === undefined;
const SKIP = process.platform === 'win32' ? 'Windows 没有 expect，跳过 pty 用例' : !HAS_EXPECT && '环境里没有 expect，跳过 pty 用例';

/** 剥掉 ANSI 序列，只看可见文本（`To resume …` 那行本身带暗色前缀）。 */
function visible(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** Tcl 双引号字符串：把 `"` `\` `$` `[` 转义掉（路径里一般没有，但不转就是在赌）。 */
function tclQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('[', '\\[')}"`;
}

interface ExitCaseResult {
  output: string;
  /** expect 进程的退出码（0 = 自己退出了；2/3 = 等首帧/等退出超时）。 */
  code: number | null;
}

/**
 * 起一次 TUI（真 pty），等它画出预置的那条消息，喂几个键，收输出。
 *
 * @param keys 依次发给终端的按键（之间隔 150ms —— 够落在 Ctrl+C 的 500ms 双击窗口内）。
 */
async function runExitCase(keys: string[], id: string): Promise<ExitCaseResult> {
  // 家目录与工作目录都建在**真路径**上：macOS 的 `tmpdir()` 是 `/var/folders/…`，
  // 而 `/var` 是指向 `/private/var` 的软链 —— 不 realpath 的话，子进程里
  // `process.cwd()` 得到 `/private/var/…`，与我们算出来的会话目录（`/var/…`）
  // 是两个字符串，`resumeCommand()` 会以为文件不存在，于是**假失败**。
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'ela-exit-home-'));
  const cwd = mkdtempSync(path.join(realpathSync(tmpdir()), 'ela-exit-work-'));
  try {
    // 一个不联网的桩 provider：TUI 启动只要求「配置里有这个 provider/model」，
    // 真发请求才会碰 baseUrl。这里不会发请求。
    writeFileSync(
      path.join(home, 'models.json'),
      JSON.stringify({
        providers: {
          stub: {
            baseUrl: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            models: [{ id: 'stub-1', contextWindow: 100000, maxTokens: 1000, input: ['text'], output: ['text'] }],
          },
        },
      }),
    );
    // 预置「聊过一句」的会话文件（有它才有恢复提示）。
    const sessionDir = path.join(home, 'sessions', encodeCwd(cwd));
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, sessionFileName(id, '2026-10-12T00:00:00.000Z')),
      [
        JSON.stringify({ type: 'session', version: 1, id, timestamp: new Date().toISOString(), cwd }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: 'hello from exit test', timestamp: Date.now() },
          id: 'e1',
          parentId: null,
          timestamp: new Date().toISOString(),
        }),
        '',
      ].join('\n'),
    );

    const spawnArgs = [
      process.execPath,
      '--import',
      'tsx',
      path.join(ROOT, 'src', 'tui.ts'),
      '--provider',
      'stub',
      '--model',
      'stub-1',
      '--session',
      id,
      '--cwd',
      cwd,
      '--no-extensions',
    ];
    const scriptPath = path.join(cwd, 'exit-case.exp');
    writeFileSync(
      scriptPath,
      [
        'set timeout 60',
        'log_user 1',
        `spawn -noecho ${spawnArgs.map(tclQuote).join(' ')}`,
        '# 等界面真的画出来（恢复出来的那条消息在对话区）再喂键。',
        'expect {',
        '  -re "hello from exit test" {}',
        '  timeout { exit 2 }',
        '}',
        ...keys.flatMap((key) => ['after 150', `send "\\${key.charCodeAt(0).toString(8)}"`]),
        'set timeout 20',
        'expect {',
        '  eof {}',
        '  timeout { exit 3 }',
        '}',
        '',
      ].join('\n'),
    );

    return await new Promise<ExitCaseResult>((resolve, reject) => {
      const child = spawn('expect', ['-f', scriptPath], {
        // cwd 必须是仓库根：`--import tsx` 按**当前目录**解析 tsx 包，
        // 工作目录用 `--cwd` 交给 ela（工具边界与会话目录都认它）。
        cwd: ROOT,
        env: { ...process.env, PI_CODING_AGENT_DIR: home, COLUMNS: '100', LINES: '30', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ output: out, code }));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('退出提示：Ctrl+C 连按两次与 Ctrl+D 一样打 `ela --session <id>`', { skip: SKIP }, async () => {
  const ctrlCId = '01a12f6f-8c1d-77dc-b023-d479a59da1f4';
  const ctrlC = await runExitCase(['\x03', '\x03'], ctrlCId);
  const text = visible(ctrlC.output);
  assert.equal(ctrlC.code, 0, `连按两次 Ctrl+C 应该自己退出（expect 退出码 ${ctrlC.code}）。输出末尾：\n${text.slice(-2000)}`);
  assert.ok(
    text.includes(`To resume this session: ela --session ${ctrlCId}`),
    `Ctrl+C 退出后应打恢复提示。实际可见输出末尾：\n${text.slice(-2000)}`,
  );

  const ctrlDId = '01a12f6f-8c1d-77dc-b023-d479a59da1f5';
  const ctrlD = await runExitCase(['\x04'], ctrlDId);
  const dText = visible(ctrlD.output);
  assert.equal(ctrlD.code, 0, `Ctrl+D 应该自己退出（expect 退出码 ${ctrlD.code}）。输出末尾：\n${dText.slice(-2000)}`);
  assert.ok(
    dText.includes(`To resume this session: ela --session ${ctrlDId}`),
    `Ctrl+D 退出后应打恢复提示。实际可见输出末尾：\n${dText.slice(-2000)}`,
  );
});