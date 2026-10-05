/**
 * 用户消息 content 块（附件）的解析与校验 —— 纯函数。
 *
 * ## 这个文件为什么存在
 *
 * 浏览器发图片走的是**浏览器**那条路：pi-web-ui 的 MessageEditor 读文件 → base64，
 * 然后塞进 `session.prompt({role:'user-with-attachments', content, attachments})`。
 * 内核的工具（read/write/edit/bash）在这条路上完全不参与。
 *
 * 所以 `/api/message` 收到的是一大坨 JSON，混着用户文本和若干 base64 图片。这个文件负责
 * **验**它们：HTTP 进来的东西一律不可信，一个畸形块不能进 state。
 *
 * ## 为什么不直接用 pi-web-ui 的 `convertAttachments`
 *
 * 折法必须与它一致（否则界面上是一种形状、发给模型是另一种），但它会把
 * pdfjs / jszip / xlsx 整条依赖链拉进内核模块图 —— 内核不需要解析文档，
 * 它只需要「已经折好的块」。
 */
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

/** 用户消息里允许的 content 块（与 pi-ai 的 `UserMessage['content']` 对齐）。 */
export type UserContentBlock = TextContent | ImageContent;

/**
 * 单张图片解码后的大小上限。
 *
 * 取 pi-web-ui 那边 `maxFileSize = 20MB` 的同一量级。为什么要卡：图片会**内联**进
 * `state.messages`，之后被 ① 写进会话 JSONL、② 每 40ms 推一帧全量状态给浏览器。
 * 不卡上限，一张 100MB 的图会把会话文件写到几百 MB，且把每帧 SSE 撑成几十 MB ——
 * 整个界面卡死。那不是「图片没显示」，是「打不开页面」。
 */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/** base64 字符集（含 padding）。 */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 放行的图片类型。白名单而不是 `image/*`：
 *
 * - SVG 在多数 vision 模型上不支持；
 * - 它同时是个可执行文档，放进来是纯风险。
 *
 * 明确拒绝比「收下再让模型报错」好 —— 报错点离现场太远。
 */
const IMAGE_MIME: ReadonlyMap<string, string> = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['image/bmp', 'image/bmp'],
  ['image/avif', 'image/avif'],
]);

/** content 不合法。调用方（HTTP 层）据此回 400。 */
export class ContentParseError extends Error {
  override readonly name = 'ContentParseError';
}

/** base64 字符数 → 解码字节数。 */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function parseTextBlock(block: Record<string, unknown>): TextContent {
  const text = block['text'];
  if (typeof text !== 'string') {
    throw new ContentParseError('text 块缺 text 字段');
  }
  return { type: 'text', text };
}

function parseImageBlock(block: Record<string, unknown>): ImageContent {
  const data = block['data'];
  const mimeType = block['mimeType'];
  if (typeof data !== 'string' || data.length === 0) {
    throw new ContentParseError('image 块缺 data');
  }
  if (!BASE64.test(data)) {
    // 明确报错而不是原样放行：非 base64 的 data 进了 state，等到回放 / 换 provider
    // 重发时才会炸，那时已经离现场太远。
    throw new ContentParseError('image.data 不是合法的 base64');
  }
  const bytes = base64ByteLength(data);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new ContentParseError(
      `图片 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB`,
    );
  }
  // mimeType 可能带 `;base64` 之类参数。
  const normalized = String(mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const allowed = IMAGE_MIME.get(normalized);
  if (!allowed) {
    throw new ContentParseError(`不支持的图片类型：${normalized || '(空)'}`);
  }
  return { type: 'image', data, mimeType: allowed };
}

/**
 * 解析 `/api/message` 带来的 content 块。
 *
 * 返回 `undefined` = 「没有 content，走纯文本那条老路」。刻意不返回空数组：
 * 空数组会让服务端和 reducer 多出一种状态形状（`content: []`），而它与「无 content」
 * 语义完全一样。
 *
 * 抛 `ContentParseError` = 「有 content 但不合法」。
 */
export function parseUserContent(value: unknown): UserContentBlock[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ContentParseError('content 必须是数组');
  }
  if (value.length === 0) return undefined;

  const blocks: UserContentBlock[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') {
      throw new ContentParseError('content 块必须是对象');
    }
    const block = raw as Record<string, unknown>;
    const type = block['type'];
    if (type === 'text') {
      blocks.push(parseTextBlock(block));
    } else if (type === 'image') {
      blocks.push(parseImageBlock(block));
    }
    // 未知块直接丢，不报错：浏览器版本比内核新时可能带新块类型，
    // 拦住整个消息比丢掉一个未知块更糟。
  }
  return blocks.length > 0 ? blocks : undefined;
}

/** content 里有没有图片。 */
export function hasImageBlock(blocks: readonly UserContentBlock[] | undefined): boolean {
  return blocks?.some((b) => b.type === 'image') ?? false;
}

/** content 里的全部文本（轨迹节点的 label/detail 只放得下纯文本）。 */
export function contentText(blocks: readonly UserContentBlock[] | undefined): string {
  return (blocks ?? [])
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * 传帧时用来代替 base64 的占位前缀。
 *
 * 见 `stubImageData` / `resolveImageStub`：广播帧不带整张图。
 */
export const IMAGE_STUB_PREFIX = ' img:';

/**
 * 把一张图的 base64 折成短占位串。
 *
 * ## 为什么需要
 *
 * 图片内联在 `state.messages` 里，而 SSE 推的是**全量帧**，流式生成时每 40ms 一帧
 * （一次回合几百帧）。一张 2MB 的图 → base64 约 2.7MB 字符 → 一次回合就是几百 MB
 * 的重复传输 + 重复 `JSON.stringify`。会话里有一张图就足以让界面彻底卡住，
 * 而这与「图片显示不出来」是两回事，很容易把方向搞反。
 *
 * ## 怎么折
 *
 * 占位 = 前缀 + base64 的 FNV-1a 32 位哈希 + 字节数。浏览器用**同一个函数**
 * 换回 data URL，两边不需要额外协议。
 *
 * 为什么用内容哈希而不是序号：占位必须由**内容本身**决定。同一张图会出现在
 * 「首帧」「/api/snapshot」「广播帧」三处，序号各不相同，浏览器就认不出来。
 * 内容哈希是纯函数，天然一致。
 */
export function stubImageData(data: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data.charCodeAt(i);
    // FNV 的 16777619 用移位加法表达，避免 32 位溢出变成小数。
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `${IMAGE_STUB_PREFIX}${hash.toString(36)}.${base64ByteLength(data)}`;
}

/** 这个 data 是不是占位串（而不是真 base64）。 */
export function isImageStub(data: string): boolean {
  return data.startsWith(IMAGE_STUB_PREFIX);
}

/**
 * 占位 → 真 base64。取不到就返回空串：宁可显示不了图，也不抛错把整个界面弄挂。
 *
 * 认得的前提是浏览器缓存里有这张图 —— 缓存在**首帧**（带真图）时填满。
 * 取不到意味着这张图真的丢了（比如另一个标签页开的会话），显示不出比崩掉好。
 */
export function resolveImageStub(
  data: string,
  mimeType: string,
  cache: ReadonlyMap<string, string>,
): string {
  if (!isImageStub(data)) return data;
  return cache.get(data) ?? '';
}
