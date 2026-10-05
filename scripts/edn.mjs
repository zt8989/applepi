// 极简 EDN 读取器 —— 只为读 clj-harness 的 `config.edn` 而写。
//
// 为什么不用现成的库：为了读一个配置文件引入依赖不划算；而 EDN 的这个子集
// （map / vector / set / string / keyword / number / 布尔 / nil / 注释）足够稳定，
// 手写一个递归下降解析器比拉依赖更可控。
//
// 不支持的东西（遇到了会抛，不静默吞）：`#()` 求值、`#"..."` 正则、`@{...}` 命名空间映射、
// tagged literal（`#inst` 等）。配置文件里不该出现这些；真出现了说明文件不是我以为的那种，
// 应该显式失败而不是猜。
//
// 键统一转成字符串（`:foo` → `"foo"`），值保留原始 JS 类型。所以
// `{"providers" "workbuddy"}` 和 `{providers workbuddy}` 读出来一样。

class EdnParser {
  constructor(src) {
    this.src = src;
    this.pos = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.readValue();
    this.skipWhitespace();
    if (this.pos < this.src.length) {
      throw new Error(
        `EDN 第 ${this.pos} 字符处有多余内容：${this.src.slice(this.pos, this.pos + 20)}`,
      );
    }
    return value;
  }

  skipWhitespace() {
    for (;;) {
      // EDN 里逗号也是分隔符（`:a 1, :b 2`），必须当空白吃掉，
      // 否则 readAtom 会在逗号处读到空 token。
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos] ?? '')) this.pos += 1;
      if (this.src[this.pos] === ';') {
        // 行注释
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  expect(ch) {
    if (this.src[this.pos] !== ch) {
      throw new Error(
        `EDN 第 ${this.pos} 字符处期望 ${ch}，实际是 ${this.src[this.pos] ?? 'EOF'}`,
      );
    }
    this.pos += 1;
  }

  readValue() {
    this.skipWhitespace();
    const ch = this.src[this.pos];
    if (ch === undefined) throw new Error('EDN 意外结束');
    if (ch === '{') return this.readMap();
    if (ch === '[') return this.readVector();
    if (ch === '#' && this.src[this.pos + 1] === '{') return this.readSet();
    if (ch === '"') return this.readString();
    if (ch === '\\') {
      throw new Error(`EDN 第 ${this.pos} 字符处是字符字面量 —— 这个解析器不支持`);
    }
    if (ch === '#') {
      const tag = this.src.slice(this.pos, this.pos + 12);
      throw new Error(`EDN 第 ${this.pos} 字符处是 tagged literal（${tag}）—— 不支持`);
    }
    return this.readAtom();
  }

  /** `#{...}` 集合。 */
  readSet() {
    this.expect('#');
    this.expect('{');
    const out = new Set();
    for (;;) {
      this.skipWhitespace();
      if (this.src[this.pos] === '}') {
        this.pos += 1;
        return out;
      }
      const value = this.readValue();
      out.add(typeof value === 'string' ? value : String(value));
    }
  }

  readMap() {
    this.expect('{');
    const out = {};
    for (;;) {
      this.skipWhitespace();
      if (this.src[this.pos] === '}') {
        this.pos += 1;
        return out;
      }
      const key = this.readValue();
      const keyText = typeof key === 'string' ? key : String(key);
      this.skipWhitespace();
      out[keyText] = this.readValue();
    }
  }

  readVector() {
    this.expect('[');
    const out = [];
    for (;;) {
      this.skipWhitespace();
      if (this.src[this.pos] === ']') {
        this.pos += 1;
        return out;
      }
      out.push(this.readValue());
    }
  }

  readString() {
    this.expect('"');
    let out = '';
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) throw new Error('EDN 字符串未闭合');
      this.pos += 1;
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.src[this.pos];
        this.pos += 1;
        if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else {
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        }
        continue;
      }
      out += ch;
    }
  }

  /** 裸值：keyword / 数字 / true / false / nil / 符号。 */
  readAtom() {
    const start = this.pos;
    while (this.pos < this.src.length && !/[\s,}\]"]/.test(this.src[this.pos] ?? '')) {
      this.pos += 1;
    }
    const token = this.src.slice(start, this.pos);
    if (token === '') throw new Error(`EDN 第 ${start} 字符处解析失败`);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'nil') return null;
    if (/^[-+]?\d+(\.\d+)?$/.test(token)) return Number.parseFloat(token);
    if (token.startsWith(':')) return token.slice(1); // keyword
    return token;
  }
}

/** 解析一段 EDN 文本。 */
export function parseEdn(text) {
  return new EdnParser(text).parse();
}

/** 取嵌套字段，路径任一段不存在就返回 undefined（不抛）。 */
export function dig(value, ...path) {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor) || cursor instanceof Set) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

/** 把值视作字符串（不是就返回 undefined）。 */
export function asString(value) {
  return typeof value === 'string' ? value : undefined;
}

/** 把值视作字符串数组（`#{:image :text}` 或 `[:image :text]`）。 */
export function asStringSet(value) {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return undefined;
}
