/**
 * 纯 TS 的 SHA-1（十六进制输出）。
 *
 * 轨迹节点的 id 要做成 git 那样的内容 hash，而 `trace.ts` 是同构模块
 * （Node 落文件、浏览器落 localStorage），所以不引 `node:crypto`，
 * 在这里自带一份实现：纯函数、无 IO、无随机数，两端算出同一个值。
 *
 * 只有一个调用方（节点 id），性能足够：每节点一次、几百字节到几十 KB 的输入。
 */

const K = [
  0x5a82_7999, 0x6ed9_eba1, 0x8f1b_bcdc, 0xca62_c1d6,
] as const;

/** 32 位循环左移。 */
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function sha1Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const bitLength = data.length * 8;

  // 填充：先补一个 0x80，再补 0 到 ≡56 (mod 64)，末 8 字节是 64 位大端比特长度。
  const padded = (((data.length + 8) >> 6) + 1) << 6;
  const words = new Uint32Array(padded >> 2);
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (byte === undefined) break;
    const slot = i >> 2;
    words[slot] = ((words[slot] ?? 0) | (byte << ((3 - (i & 3)) * 8))) >>> 0;
  }
  // 0x80 落在消息末尾自己的字节槽里（padded ≥ len+9，不会碰到长度字段）。
  const at = data.length;
  const atSlot = at >> 2;
  words[atSlot] = ((words[atSlot] ?? 0) | (0x80 << ((3 - (at & 3)) * 8))) >>> 0;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  words[words.length - 2] = high;
  words[words.length - 1] = low;

  let h0 = 0x6745_2301;
  let h1 = 0xefcd_ab89;
  let h2 = 0x98ba_dcfe;
  let h3 = 0x1032_5476;
  let h4 = 0xc3d2_e1f0;

  const w = new Uint32Array(80);
  const read = (t: number): number => w[t] ?? 0;
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t += 1) w[t] = words[block + t] ?? 0;
    for (let t = 16; t < 80; t += 1) {
      w[t] = rotl(read(t - 3) ^ read(t - 8) ^ read(t - 14) ^ read(t - 16), 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t += 1) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = K[0];
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = K[1];
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = K[2];
      } else {
        f = b ^ c ^ d;
        k = K[3];
      }
      const temp = (rotl(a, 5) + f + e + k + read(t)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}
