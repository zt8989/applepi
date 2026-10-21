/**
 * 附件：浏览器 → 服务端的**发送投影**，以及服务端消息 → 界面的**展示投影**。
 *
 * 两个方向不对称，因为环在服务端、只有两样东西真的过线：**图片**必须带 `content`（base64，它就是
 * `ImageContent.data`），**文档**只带 `extractedText`（原文件 base64 传一遍再写进会话文件就是几十 MB
 * 的垃圾）。
 *
 * 展示方向反过来：历史里只有 pi 的 `content` 块，这里还原成 pi-web-ui 认的
 * `user-with-attachments` 消息 —— 于是 `UserMessage` 会画缩略图 / 文件格子，点开是它自己的
 * `AttachmentOverlay`，不用另写一套渲染器。
 */

import type { WebAttachment } from '@ela/core/web-protocol';
import type { Attachment } from '@earendil-works/pi-web-ui';

/** 桥生成的图片标签（带文件名）。 */
const IMAGE_LABEL = /^\[Image: (.+)\]$/;

/** 桥生成的文档块前缀 —— 与 pi-web-ui 的 `convertAttachments()` 逐字同形。 */
const DOCUMENT_PREFIX = '\n\n[Document: ';

/**
 * pi-web-ui 传给 `session.prompt()` 的入参 → 线协议上的 `WebAttachment[]`。
 *
 * 认不出 / 用不了的条目直接跳过（服务端还会再验一遍，那里才是信任边界）。
 */
export function extractAttachments(input: unknown): WebAttachment[] {
  if (typeof input !== 'object' || input === null) return [];
  const raw = (input as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];

  const attachments: WebAttachment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const attachment = item as Partial<Attachment>;
    if (typeof attachment.fileName !== 'string' || attachment.fileName === '') continue;
    if (typeof attachment.mimeType !== 'string' || attachment.mimeType === '') continue;
    const type = attachment.type;
    if (type === 'image') {
      if (typeof attachment.content !== 'string' || attachment.content === '') continue;
      attachments.push({
        id: typeof attachment.id === 'string' ? attachment.id : `image-${attachments.length + 1}`,
        type,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: typeof attachment.size === 'number' ? attachment.size : 0,
        content: attachment.content,
      });
      continue;
    }
    if (type === 'document') {
      // 文档只带正文：原文件 base64 对模型没用，只会把会话文件撑大。
      if (typeof attachment.extractedText !== 'string' || attachment.extractedText.trim() === '') continue;
      attachments.push({
        id: typeof attachment.id === 'string' ? attachment.id : `document-${attachments.length + 1}`,
        type,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: typeof attachment.size === 'number' ? attachment.size : 0,
        content: '',
        extractedText: attachment.extractedText,
      });
    }
  }
  return attachments;
}

/**
 * 服务端那份 `state.messages` → pi-web-ui 能画出附件的形状。
 *
 * 只动**带图片 / 文档块**的用户消息：其余消息原样返回（引用不变，pi-web-ui 的
 * 重复渲染不会因为整批换了新对象而丢掉自己的状态）。
 *
 * 转换结果：
 * - `role` 变成 `user-with-attachments`（`MessageList` 认它，交给 `UserMessage`）；
 * - `content` 变成**纯文本串**（丢掉 `[Image: …]` 标签与文档正文，只留人打的那句话）；
 * - `attachments` 是 `UserMessage` 要的 `Attachment[]`（缩略图 / 文件格子）。
 */
export function withUserAttachments(messages: readonly unknown[]): unknown[] {
  return messages.map(withMessageAttachments);
}

/** 单条消息的版本（`withUserAttachments` 的实现，导出给单测）。 */
export function withMessageAttachments(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'user' || !Array.isArray(record.content)) return message;

  const blocks = record.content as unknown[];
  const attachments: Attachment[] = [];
  const texts: string[] = [];
  let pendingImageName: string | undefined;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (typeof block !== 'object' || block === null) continue;

    if (isImageBlock(block)) {
      const fileName =
        pendingImageName ?? `image-${attachments.length + 1}.${extensionForMimeType(block.mimeType)}`;
      attachments.push({
        id: `history-image-${attachments.length + 1}`,
        type: 'image',
        fileName,
        mimeType: block.mimeType,
        size: base64Size(block.data),
        content: block.data,
        preview: block.data,
      });
      pendingImageName = undefined;
      continue;
    }

    if ((block as { type?: unknown }).type !== 'text') continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string') continue;

    // 标签只在**紧跟一张图**时才消费 —— 用户自己打的 `[Image: …]` 不受影响。
    const label = IMAGE_LABEL.exec(text);
    if (label !== null && index + 1 < blocks.length && isImageBlock(blocks[index + 1])) {
      pendingImageName = label[1];
      continue;
    }

    const document = parseDocumentBlock(text, attachments.length + 1);
    if (document !== null) {
      attachments.push(document);
      continue;
    }

    texts.push(text);
  }

  if (attachments.length === 0) return message;

  return {
    ...record,
    role: 'user-with-attachments',
    content: texts.join('\n'),
    attachments,
  };
}

function isImageBlock(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  if (typeof value !== 'object' || value === null) return false;
  const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    block.type === 'image' &&
    typeof block.data === 'string' &&
    block.data !== '' &&
    typeof block.mimeType === 'string' &&
    block.mimeType.startsWith('image/')
  );
}

/**
 * `\n\n[Document: 名字]\n正文` → 一个文档附件。
 *
 * 前缀里那两个换行是**桥加的**（与 pi-web-ui 的 `convertAttachments()` 一致），
 * 所以用户自己打的一句 `[Document: x]`（第一块、没有前导换行）不会被误认。
 */
function parseDocumentBlock(text: string, ordinal: number): Attachment | null {
  if (!text.startsWith(DOCUMENT_PREFIX)) return null;
  const rest = text.slice(DOCUMENT_PREFIX.length);
  const head = rest.indexOf(']\n');
  if (head <= 0) return null;
  const fileName = rest.slice(0, head);
  if (fileName === '') return null;
  return {
    id: `history-document-${ordinal}`,
    type: 'document',
    fileName,
    // 原文件不在历史里（桥只留正文）—— 按纯文本给 overlay，别让它去解析一份空 PDF。
    mimeType: 'text/plain',
    size: 0,
    content: '',
    extractedText: rest.slice(head + 2),
  };
}

/** base64 的原始字节数（界面显示用；差几个字节无所谓）。 */
function base64Size(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * 没有文件名时按 MIME 猜个扩展名（缩略图不显示名字，只用于 `title`）。
 */
function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'png';
  }
}
