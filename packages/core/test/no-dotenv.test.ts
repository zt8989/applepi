import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiKey } from '../src/provider';

/**
 * 守住「不读 `.env`」这条约定。
 *
 * ## 这个测试守什么
 *
 * 早先 `pnpm start` 跑的是 `node --env-file-if-exists=.env …`，key 从仓库根的 `.env`
 * 来。那有个隐蔽的坏处：`.env` 里的 key 只对**那个仓库**有意义，而 `ela` 是全局命令
 * —— 一旦启动器也去读 `cwd/.env`，症状是「A 项目的 key 被发给了 B 项目」。那比
 * 「读不到 key」难查得多：请求成功、账单记在别人头上。
 *
 * 所以凭证只走三条路（顺序即优先级，见 provider.ts / pi-config.ts）：
 *
 *   1. shell 环境变量 `<ID>_API_KEY`（`--api-key` 最终也写进这里）
 *   2. `~/.pi/agent/auth.json`
 *   3. models.json 条目内的 `apiKey`
 *
 * 仓库里**不该再有** `.env` / `.env.example`，脚本里也不该再有 `--env-file`。
 */

/** 仓库根目录（从本文件位置推：packages/core/test → 仓库根）。 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 工作区里所有 package.json —— 根包与 packages/* 都要查（脚本不再只有一份）。 */
function workspacePackageJsons(): string[] {
  const files = [path.join(repoRoot, 'package.json')];
  for (const name of fs.readdirSync(path.join(repoRoot, 'packages'))) {
    const file = path.join(repoRoot, 'packages', name, 'package.json');
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

test('仓库里没有 .env —— 凭证只走 auth.json / 环境变量', () => {
  for (const name of ['.env', '.env.example', '.env.local']) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, name)),
      false,
      `${name} 不该存在：要加 key 请写 ~/.pi/agent/auth.json 或设环境变量` +
        '（从调用目录读 .env 会把 A 项目的 key 发给 B 项目）',
    );
  }
});

test('package.json 的脚本里没有 --env-file', () => {
  for (const file of workspacePackageJsons()) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      assert.equal(
        /--env-file/.test(command),
        false,
        `${path.relative(repoRoot, file)} 的脚本 ${name} 不该带 --env-file：${command}`,
      );
    }
  }
});

test('凭证错误信息指向 auth.json / 环境变量，不提 .env', () => {
  // 造一个必定没有 key 的 provider 名：真实 env 里不会有这么个变量。
  const missing = 'definitely-not-a-real-provider-xyz';
  assert.equal(
    process.env[`${missing.toUpperCase()}_API_KEY`],
    undefined,
    '探针前提：这个 provider 在环境里确实没有 key',
  );
  assert.throws(
    () => resolveApiKey(missing),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 报错是用户看到的第一手信息 —— 指向一个已经删掉的口子比不指更糟。
      assert.match(message, /auth\.json/, '要指向 auth.json');
      assert.equal(message.includes('.env'), false, '不该再提 .env');
      return true;
    },
  );
});