/**
 * 「完整历史」那一页 —— 服务端渲染（`GET /api/history`）。
 *
 * ## 为什么是一页 HTML，而不是一个接口给 JSON
 *
 * 这份东西是**给人读的**：一次会话里几百条消息、工具结果一大片，前端拿到 JSON 还得
 * 再写一套渲染，而它不该长在聊天界面里（要能新标签页开着、能 Ctrl-F、能打印）。
 * 一条路由 + 一段字符串拼装（本文件）比「接口 + 前端页面」少一层，也没有第二处
 * 会漂移的格式。
 *
 * 对齐的是 Pi Web 的 `完整历史`（`/api/sessions/<id>/export`）：都是「把完整会话
 * 记录铺成一页」。差别只在 Pi Web 导出的是它自己的会话目录，我们读的是**同一条**
 * 会话文件（`~/.pi/agent/sessions/...`）——它和终端、和 pi 是同一份。
 *
 * ## 为什么样式是内联的
 *
 * 这一页在**新标签页**里打开，而 webui 的样式表（Tailwind 产物）是给 SPA 那条路由
 * 用的，不会跟着来。所以这里自带一份最小 CSS —— 也只做「读得下去」这一件事：
 * 等宽、分块、深色跟随系统。
 */
import type { Message } from '@earendil-works/pi-ai';
import type {
  ModelChangeEntry,
  SessionEntry,
  ThinkingChangeEntry,
} from '@ela/core/session-file';
import type { WebHistoryInfo, WebHistoryLine } from '@ela/core/web-protocol';

/** HTML 转义。会话内容里什么字符都可能出现（`<script>`、`&`、引号），一个都不能漏。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 本地时间（`YYYY-MM-DD HH:mm:ss`）。`toLocaleString` 的格式因平台而异，这里自己拼。 */
function localTime(at: string | number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 内容块里的文本：图片这类没有文字的块给一个占位（否则那一条会看起来是空的）。 */
function contentText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    switch (record['type']) {
      case 'text':
        if (typeof record['text'] === 'string') parts.push(record['text']);
        break;
      case 'thinking':
        if (typeof record['thinking'] === 'string') parts.push(record['thinking']);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      default:
        // 认不出的块（扩展自己的形状）也留一行，总比静默丢掉强。
        parts.push(`[${String(record['type'] ?? '未知块')}]`);
    }
  }
  return parts.join('\n');
}

/** 一条消息 → 若干 HTML 片段。 */
function messageHtml(message: Message): string {
  const at = localTime(message.timestamp);
  switch (message.role) {
    case 'user':
      return entry('user', '你', at, [
        `<pre class="text">${escapeHtml(contentText(message.content))}</pre>`,
      ]);
    case 'assistant': {
      const parts: string[] = [];
      for (const block of message.content ?? []) {
        if (block.type === 'thinking') {
          parts.push(`<div class="thinking"><div class="label">思考</div><pre class="text">${escapeHtml(block.thinking)}</pre></div>`);
          continue;
        }
        if (block.type === 'text') {
          parts.push(`<pre class="text">${escapeHtml(block.text)}</pre>`);
          continue;
        }
        if (block.type === 'toolCall') {
          const args = (() => {
            try {
              return JSON.stringify(block.arguments ?? {}, null, 2);
            } catch {
              return String(block.arguments);
            }
          })();
          parts.push(
            `<div class="tool-call"><div class="label">调用 <code>${escapeHtml(block.name)}</code></div>` +
              `<pre class="text">${escapeHtml(args)}</pre></div>`,
          );
        }
      }
      if (typeof message.errorMessage === 'string' && message.errorMessage !== '') {
        parts.push(`<pre class="text error">${escapeHtml(message.errorMessage)}</pre>`);
      }
      if (parts.length === 0) parts.push('<pre class="text">（空回复）</pre>');
      return entry('assistant', `${message.model}`, at, parts);
    }
    case 'toolResult':
      return entry(
        message.isError === true ? 'tool error' : 'tool',
        message.toolName,
        at,
        [`<pre class="text">${escapeHtml(contentText(message.content) || '（无输出）')}</pre>`],
      );
    default:
      // `system`（head 那条）在轨迹里也出现过 —— 原样铺开，别让它神秘消失。
      return entry(String(message.role), '', at, [
        `<pre class="text">${escapeHtml(contentText((message as { content?: unknown }).content))}</pre>`,
      ]);
  }
}

/** 一条时间线条目的外壳。 */
function entry(kind: string, who: string, at: string, body: readonly string[]): string {
  const role = kind.split(' ')[0] ?? kind;
  return (
    `<article class="entry ${role}">` +
    `<div class="entry-head"><span class="role">${escapeHtml(kind)}</span>` +
    (who === '' ? '' : `<span class="who">${escapeHtml(who)}</span>`) +
    `<span class="at">${escapeHtml(at)}</span></div>` +
    body.join('') +
    `</article>`
  );
}

function lineHtml(line: WebHistoryLine): string {
  if (line.kind === 'note') {
    return `<div class="note">${escapeHtml(localTime(line.at))} · ${escapeHtml(line.text)}</div>`;
  }
  return messageHtml(line.message);
}

/**
 * 会话文件里的 entry → 线协议的时间线（供 `GET /api/history`）。
 *
 * 只认三种真的会出现在「完整历史」里的 entry：消息、模型切换、思考级别切换。
 * 其余（`session_info` 那种写给工具用的元数据）不进时间线 —— 它在给人读的页面上
 * 只会是噪音。
 */
export function historyLines(entries: readonly SessionEntry[]): WebHistoryLine[] {
  const lines: WebHistoryLine[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        const message = (entry as unknown as { message?: Message }).message;
        if (message !== undefined) lines.push({ kind: 'message', at: entry.timestamp, message });
        break;
      }
      case 'model_change': {
        const change = entry as ModelChangeEntry;
        lines.push({ kind: 'note', at: entry.timestamp, text: `模型 → ${change.provider}/${change.modelId}` });
        break;
      }
      case 'thinking_level_change': {
        const change = entry as ThinkingChangeEntry;
        lines.push({ kind: 'note', at: entry.timestamp, text: `思考级别 → ${change.thinkingLevel}` });
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

/** 整页。 */
export function renderHistoryPage(info: WebHistoryInfo): string {
  const messages = info.lines.filter((line) => line.kind === 'message').length;
  const body = info.lines.map(lineHtml).join('\n');
  const source =
    info.file === null
      ? '还没落盘（新会话，内容来自内存）'
      : info.file;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>完整历史 · ${escapeHtml(info.sessionId)}</title>
<style>
  :root { --bg: #fff; --panel: #fafafa; --border: #e5e5e5; --text: #111; --muted: #666; --accent: #2563eb; --error: #dc2626; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1a1a; --panel: #222; --border: #333; --text: #eee; --muted: #999; --accent: #60a5fa; --error: #f87171; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 16px 64px; background: var(--bg); color: var(--text);
    font: 13px/1.6 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  header { max-width: 60rem; margin: 0 auto; padding: 20px 0 12px; border-bottom: 1px solid var(--border); }
  h1 { margin: 0 0 6px; font-size: 16px; }
  .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 60rem; margin: 0 auto; }
  .entry { margin: 14px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); overflow: hidden; }
  .entry-head { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  .entry-head .role { font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .entry.user .entry-head .role { color: var(--accent); }
  .entry.tool .entry-head .role { color: var(--muted); }
  .entry.tool.error .entry-head .role { color: var(--error); }
  .entry-head .at { margin-left: auto; font-variant-numeric: tabular-nums; }
  pre.text {
    margin: 0; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  pre.text.error { color: var(--error); }
  .thinking, .tool-call { border-top: 1px solid var(--border); }
  .thinking .label, .tool-call .label { padding: 6px 10px 0; font-size: 11px; color: var(--muted); }
  .thinking pre.text { color: var(--muted); font-style: italic; }
  .note { margin: 10px 0; color: var(--muted); font-size: 12px; font-style: italic; }
  .empty { margin: 24px 0; color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>完整历史</h1>
  <div class="meta">会话 <code>${escapeHtml(info.sessionId)}</code> · 工作目录 <code>${escapeHtml(info.cwd)}</code></div>
  <div class="meta">${messages} 条消息 · 来源 <code>${escapeHtml(source)}</code></div>
</header>
<main>
${body === '' ? '<p class="empty">这次会话还没有内容。</p>' : body}
</main>
</body>
</html>
`;
}
