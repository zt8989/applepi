/**
 * 用户消息里的图片 —— 补上 pi-web-ui 缺的那块渲染。
 *
 * ## 为什么必须自己写
 *
 * pi-web-ui 有两套「带图用户消息」的画法，但**都不是我们的形状**：
 *
 *   1. 内置 `<user-message>`：取 `content` 里**第一个 text 块**当正文，图片靠
 *      `message.attachments` + `<attachment-tile>` 画。
 *   2. 内置的 `user-with-attachments` 形状：那是它**自己**的 Agent 在内存里用的
 *      （`convertToLlm()` 之后才变成标准 pi-ai 消息），从不直接进 `messages`。
 *
 * 我们发给内核的是**标准 pi-ai user 消息** —— `content` 是 text/image 块数组，没有
 * `attachments` 字段。这是刻意的：它能原样喂回 provider、能落进会话 JSONL、能回放。
 * 代价就是内置渲染器只画出文字，图片消失。
 *
 * 所以渲染侧的缺口用一个自定义 renderer 补：`registerMessageRenderer('user', …)`。
 * `MessageList.buildRenderItems()` 的顺序是「先问自定义 renderer，问不到才用内置的」，
 * 而这里只注册 `user` 一个 role（assistant / toolResult 一概不动），影响面精确。
 */
import { html, type TemplateResult } from 'lit';
import { registerMessageRenderer } from '@earendil-works/pi-web-ui';
import type { Message, TextContent } from '@earendil-works/pi-ai';
import { resolveImageStub } from '../../src/message-content';

/** 缩略图最大高度（px）。再高就把聊天区挤没了；点开看原图。 */
const MAX_THUMB_HEIGHT = 220;

/**
 * 图丢了时的占位。
 *
 * 只在「占位串在缓存里找不到」时出现 —— 意味着这张图压根没到过这个页面
 * （比如另一个标签页开的会话）。显示一句提示远好过一个碎图图标。
 */
function missingImage(): TemplateResult {
  return html`<div
    class="text-xs text-muted-foreground border border-dashed border-input rounded-lg px-3 py-2"
  >
    图片不可用（该消息的图片不在本次载入的帧里）
  </div>`;
}

/** content 也可能还是纯字符串 —— 恢复旧会话时会是那样。 */
function splitContent(content: Message['content']): {
  texts: string[];
  images: { data: string; mimeType: string }[];
} {
  if (typeof content === 'string') {
    return { texts: content ? [content] : [], images: [] };
  }
  const texts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of content) {
    if (block.type === 'text') texts.push((block as TextContent).text);
    else if (block.type === 'image') images.push(block);
  }
  return { texts, images };
}

/**
 * 注册 `user` role 的渲染器。幂等（重复调用只会覆盖同一个 key）。
 *
 * 必须在 `<agent-interface>` 画出任何一条 user 消息**之前**调：renderer 是渲染时
 * 才问的，已经画出来的消息不会因为事后注册而重画。main.ts 在 createElement 前调它。
 *
 * @param imageCache 占位串 → 真 base64。由 remote-session 在收到带图首帧时填满。
 */
export function registerUserMessageRenderer(
  imageCache: ReadonlyMap<string, string>,
): void {
  registerMessageRenderer('user', {
    render(message: Message): TemplateResult {
      const { texts, images } = splitContent(message.content);
      // 文本走 markdown-block：与内置渲染器一致，所以中文 / 换行 / 代码块表现不变。
      const text = texts.join('\n\n');
      return html`
        <div class="flex justify-start mx-4">
          <div class="user-message-container py-2 px-4 rounded-xl">
            ${text ? html`<markdown-block .content=${text}></markdown-block>` : ''}
            ${images.length > 0
              ? html`
                  <div class="mt-2 flex flex-wrap gap-2">
                    ${images.map((image) => {
                      // 占位 → 真图；取不到就是空串，走 missingImage 分支。
                      const data = resolveImageStub(image.data, image.mimeType, imageCache);
                      if (!data) return missingImage();
                      const url = `data:${image.mimeType};base64,${data}`;
                      return html`
                        <a href=${url} target="_blank" rel="noopener noreferrer" title="点开看原图">
                          <img
                            src=${url}
                            alt="用户上传的图片"
                            style="max-height:${MAX_THUMB_HEIGHT}px;max-width:100%;border-radius:8px;border:1px solid var(--border,#ddd)"
                            loading="lazy"
                          />
                        </a>
                      `;
                    })}
                  </div>
                `
              : ''}
          </div>
        </div>
      `;
    },
  } as never);
}
