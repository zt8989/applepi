/**
 * 把 pi 的 `KeyId`（`alt+up` / `ctrl+q` / `alt+enter`…）翻成**传统终端会发来的那串字节**。
 *
 * 测试里为什么需要它：断言「这个键真的能命中那个动作」必须给 `matchesKey()` 一串**真字节**，
 * 而写成字面量（`'\x1b[1;3A'`）就等于**替 pi 把默认键钉死在 mac 上** —— pi 的默认键按平台
 * 分叉（见 `../src/keybindings.ts` 文件头），同一行断言在 Windows 上必挂，而挂的原因是断言
 * 过时、不是代码坏了。
 *
 * 所以：先问键位表「这一台机器上这个动作是哪个键」（`actionKeys()`），再用这里把那个键
 * 翻回字节。两边都是解析出来的，没有一处写着「mac 的答案」。
 *
 * 覆盖范围只到测试实际用到的那些：修饰键 +（字母 / 数字 / 回车 / 方向键）。
 * 别的形状直接抛 —— 抛比返回一个猜的字节串好（猜错的话断言会以「键按不动」的形式失败，
 * 那正是最难归因的一类）。
 */
const ARROWS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

const ENTER = '\r';
const ESC = '\u001b';

/** 传统终端里 `ctrl+<字母>` 的字节：`a` → `\x01` … `z` → `\x1a`。 */
function ctrlByte(letter: string): string {
  return String.fromCharCode(letter.charCodeAt(0) - 96);
}

export function legacySequence(keyId: string): string {
  const parts = keyId.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  const ctrl = parts.includes('ctrl');
  const alt = parts.includes('alt');

  if (key === 'enter') return alt ? `${ESC}${ENTER}` : ENTER;

  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    // `ESC[1;<mod>A`：mod = 1 + shift(1) + alt(2) + ctrl(4)。测试只用得到 alt 与 ctrl。
    if (ctrl) return `${ESC}[1;5${arrow}`;
    if (alt) return `${ESC}[1;3${arrow}`;
    return `${ESC}[${arrow}`;
  }

  if (key.length === 1) {
    const isLetter = key >= 'a' && key <= 'z';
    if (ctrl && !isLetter) {
      throw new Error(`legacySequence(): ctrl+${key} 不是「字母减 0x60」的原字（要测就自己补一条）`);
    }
    // `ctrl+alt+<字母>` 是传统终端里的 `ESC` + 控制字符。
    if (ctrl && alt) return `${ESC}${ctrlByte(key)}`;
    // `ctrl+shift+<字母>` 与传统终端里同型字节（`\x10`），分不开 —— 要不要区分是 kitty 协议的事。
    if (ctrl) return ctrlByte(key);
    if (alt) return `${ESC}${key}`;
    return key;
  }

  throw new Error(`legacySequence(): 没有 ${keyId} 的字节形状（要测新键就在这儿补一条）`);
}
