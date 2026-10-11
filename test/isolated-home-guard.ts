/**
 * 测试隔离的**守卫**：确认配置家目录真的是测试专用的临时目录。
 *
 * ## 这条护栏是因为真出过事才加的
 *
 * `test/tools.test.ts` 要写一份 `settings.json` 来验证 `defaultTools` 的开关规则。
 * 它的路径走 `piSettingsPath()` → `getAgentDir()`，也就是**只看 `PI_CODING_AGENT_DIR`**。
 * 而那个变量是 `isolated-home.ts` 用 `--import` 装的，**只在 `pnpm test` 的脚本里**：
 *
 *   "test": "node --import tsx --import ./test/isolated-home.ts --test test/*.test.ts"
 *
 * 于是任何**绕过这条脚本**的跑法（最常见的就是「只跑一个文件看问题」）都会让
 * `piSettingsPath()` 解析到**真实家目录** `~/.pi/agent/settings.json`。
 * 那个测试的清理是 `rm(settings.json)` —— 于是它把**用户真的配置文件**删了：
 * `defaultProvider` / `defaultModel` / `packages`（两个 npm 扩展）全没了。
 *
 * 症状特别难归因：删掉的是「配置」，而它在别的测试里表现为「扩展没装上」，
 * 指向的方向（扩展加载）完全不是原因。**所以要在这里拦住，而不是事后查。**
 *
 * ## 怎么拦
 *
 * 不去猜「临时目录长什么样」（`os.tmpdir()` 在各平台五花八门，还有 `isolated-home`
 * 自己带前缀），而是只问一个真问题：**这个路径会不会和用户的家目录同址？**
 * 同址就意味着「写它 = 改用户的配置」，直接抛错并给出正确跑法。
 */

import os from 'node:os';
import path from 'node:path';

/**
 * 断言这个配置文件路径**不是**用户的真实配置家目录。
 *
 * ## 判据：真的家目录长什么样，而不是「临时目录长什么样」
 *
 * 早先一版写反了，拿 `path.dirname(file) === configHome()` 当“危险”。
 * 但 `configHome()` 本身就是 `getAgentDir()`：**装了隔离时它就是临时目录**，
 * 于是“临时 == 配置家目录”成立 → 护栏在**正确**的跑法下误报，把好用例全拦了。
 * 方向反了：真正危险的不是“等于配置家目录”，而是**没装隔离**（此时它落在
 * 用户真家目录下）。
 *
 * 所以判据必须是“**在不在用户真家目录下、又不在临时目录里**”。
 * 装了隔离 → 路径在 `%TEMP%\redux-agent-test-home-*` → 放行；
 * 没装隔离 → 路径在 `~/.pi/agent`          → 拦下。
 *
 * **为什么要把 tmpdir 也排除掉**：Windows 上 `%TEMP%` 就在
 * `C:\Users\<你>\AppData\Local\Temp` —— 它本身**在**家目录里。只判“在不在家里”
 * 会把正确的隔离跑法也拦掉（护栏第一版就栽在这儿，一开跑就把好用例全挂了）。
 *
 * 也不要只比 `redux-agent-test-home-` 前缀 —— 那是 `isolated-home.ts` 的实现细节，
 * 护栏不该绑死。这里只问「是不是临时目录」。
 */
export function assertIsolatedHome(file: string, who: string): void {
  const target = path.resolve(path.dirname(file));
  const home = path.resolve(os.homedir());
  const temp = path.resolve(os.tmpdir());
  // 比较**所在目录**（整个文件路径太具体，重启后的临时目录名会变）。
  const inTemp = (dir: string): boolean =>
    dir === temp || dir.toLowerCase().startsWith(`${temp.toLowerCase()}${path.sep}`);
  const inHome =
    target === home || target.toLowerCase().startsWith(`${home.toLowerCase()}${path.sep}`);
  if (inTemp(target) || !inHome) return;

  throw new Error(
    `[${who}] 拒绝写入 ${file} —— 它落在**用户真实的家目录**里（${home}），\n` +
      `写它就是改用户的真实配置（历史上就真删掉过一次：provider / model / packages 全没了）。\n\n` +
      `原因：配置家目录只看 ${'PI_CODING_AGENT_DIR'}，而它由 test/isolated-home.ts 安装，\n` +
      `只有走 \`pnpm test\` 脚本才会带上 \`--import ./test/isolated-home.ts\`。\n` +
      `你现在多半是只跑了一个文件（那也是历史上出事的那个跑法）。\n\n` +
      `改成这样跑：\n` +
      `  pnpm test                                  # 全部\n` +
      `  node --import tsx --import ./test/isolated-home.ts --test test/${path.basename(who)}\n\n` +
      `（隔离生效时路径应落在 ${temp}\n` +
      `而当前是 ${target}）`,
  );
}