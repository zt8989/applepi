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
 * 三处皆无时返回 `undefined` 而不是抛错：与 pi 一致，由服务端裁决 —— 客户端
 * 提前拦会误伤 loopback 免验 key 的网关（如 magpie 的 127.0.0.1 端点）。
 * 与 pi 一样，models.json 里的占位符（如 "apiKey": "magpie"）也照发。
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

test('没配 key 的 provider 返回 undefined，不在客户端拦（与 pi 一致）', () => {
  // 造一个必定没有 key 的 provider 名：真实 env 里不会有这么个变量。
  const missing = 'definitely-not-a-real-provider-xyz';
  assert.equal(
    process.env[`${missing.toUpperCase()}_API_KEY`],
    undefined,
    '探针前提：这个 provider 在环境里确实没有 key',
  );
  assert.equal(resolveApiKey(missing), undefined);
});

test('models.json 条目内的 apiKey 占位符也被当作 key（第三档）', () => {
  const home = process.env['PI_CODING_AGENT_DIR'];
  assert.ok(home, '测试必须跑在隔离的 PI_CODING_AGENT_DIR 下');
  const provider = 'placeholder-gateway';
  fs.writeFileSync(
    path.join(home, 'models.json'),
    JSON.stringify({
      providers: {
        [provider]: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: provider, models: [] },
      },
    }),
    'utf8',
  );
  assert.equal(resolveApiKey(provider), provider);
});