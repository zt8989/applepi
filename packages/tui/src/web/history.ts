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
import type { Message, SystemMessage } from '@earendil-works/pi-ai';
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

/**
 * 内容块里的**图片** → `<img>`（data URL 直接内联，不再回服务端取一遍）。
 *
 * 图片是**会话文件里就有的东西**：`read` 读图时 pi 把图读成 base64 塞进工具结果
 * （`{type:'image', data, mimeType}`），用户发的附件也一样。早先这两处只画了
 * `[图片]` 这个占位 —— 而「完整历史」要回答的正是「当时到底看了什么」。
 *
 * 找不到 `data` / 空串的一律跳过：宁可少画一张，也不要一个 `src="data:;base64,"` 的破图。
 */
function imageBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'image') continue;
    const data = record['data'];
    if (typeof data !== 'string' || data === '') continue;
    const mime = typeof record['mimeType'] === 'string' && record['mimeType'] !== '' ? record['mimeType'] : 'image/png';
    out.push(
      `<img class="shot" src="data:${escapeHtml(mime)};base64,${escapeHtml(data)}" alt="图片" loading="lazy" title="点一下看大图">`,
    );
  }
  return out;
}

/**
 * 内容块里的**纯文本**（图片块跳过）。
 *
 * 与 `contentText()` 的分工：那个是「用一行文字代替一切」（认不出的 role 兜底用），
 * 这个只给「图片会自己画出来」的地方用（用户消息、工具结果）—— 不然一张图会既有个
 * `<img>` 又有一行 `[图片]`。
 */
function textBlocks(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text']);
    if (record['type'] === 'thinking' && typeof record['thinking'] === 'string') parts.push(record['thinking']);
  }
  return parts.join('\n');
}

/** 一条消息 → 若干 HTML 片段。 */
function messageHtml(message: Message): string {
  const at = localTime(message.timestamp);
  switch (message.role) {
    case 'user': {
      // 附图的消息：文字在前、图片在后（模型收到的顺序也是这个）。
      const parts: string[] = [];
      const text = textBlocks(message.content).trim();
      if (text !== '') parts.push(`<pre class="text">${escapeHtml(text)}</pre>`);
      parts.push(...imageBlocks(message.content));
      if (parts.length === 0) parts.push('<pre class="text">（空）</pre>');
      return entry('user', '你', at, parts);
    }
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
    case 'toolResult': {
      // `read` 读图的结果：一句 `Read image file [image/png]` + 一张图（见 `imageBlocks`）。
      const parts: string[] = [];
      const text = textBlocks(message.content);
      if (text.trim() !== '') parts.push(`<pre class="text">${escapeHtml(text)}</pre>`);
      parts.push(...imageBlocks(message.content));
      if (parts.length === 0) parts.push('<pre class="text">（无输出）</pre>');
      return entry(message.isError === true ? 'tool error' : 'tool', message.toolName, at, parts);
    }
    case 'system':
      // 请求头部（pi v3 的 head）与中途的段 patch 都走这里：分段 + 工具表。
      return entry('system', systemWho(message), at, systemMessageHtml(message));
    default:
      // 认不出的 role（扩展自己的形状）也原样铺开，别让它神秘消失。
      return entry(String((message as { role?: unknown }).role), '', at, [
        `<pre class="text">${escapeHtml(contentText((message as { content?: unknown }).content))}</pre>`,
      ]);
  }
}

/** 工具定义里的 `parameters`（JSON Schema）→ 可读的 JSON 文本。 */
function schemaText(parameters: unknown): string {
  try {
    return JSON.stringify(parameters ?? {}, null, 2);
  } catch {
    return String(parameters);
  }
}

/**
 * 一条 `system` 消息画成什么 —— 也就是**请求头部**：系统提示词的分段 + 工具表。
 *
 * ## 为什么值得单独画
 *
 * 会话文件里第一条 `message` 就是它（pi v3 的 head：`sections` = 各段正文，
 * `toolsAdded` = 装载时那批工具的完整声明），`sections` 里 20KB 的 skills 段、
 * `toolsAdded` 里 21 份 JSON Schema 都是「模型实际收到了什么」的**唯一**证据。
 * 早先这里落到 `default` 分支，只读 `content`（head 的 content 通常是空串），
 * 于是页面上只剩一个空壳 —— 「完整历史」缺了最该看的那一段。
 *
 * ## 为什么折叠起来
 *
 * 一次会话的头部是几万字符（光 skills 段就两万），全铺开会把真正的对话挤到十屏之后。
 * 所以每段、每个工具各一个 `<details>`：段名 / 工具名在折叠状态下就看得见（也就搜得到），
 * 想看正文再点开。这与 pi 自己导出的那一页同一口径（它是「预览 10 行 + 点击展开」）。
 */
function systemMessageHtml(message: SystemMessage): string[] {
  const parts: string[] = [];
  const base = contentText(message.content).trim();
  if (base !== '') parts.push(`<pre class="text">${escapeHtml(base)}</pre>`);

  const sections = message.sections ?? {};
  for (const [name, body] of Object.entries(sections)) {
    // `null` = 这一段被删掉了（中途的段 patch 用 null 移除），不是「空段」。
    if (typeof body !== 'string') continue;
    parts.push(
      `<details class="fold"><summary>段 <code>${escapeHtml(name)}</code>` +
        `<span class="size">${body.length} 字符</span></summary>` +
        `<pre class="text">${escapeHtml(body)}</pre></details>`,
    );
  }

  const tools = message.toolsAdded ?? [];
  if (tools.length > 0) {
    const items = tools.map(
      (tool) =>
        `<details class="fold"><summary><code>${escapeHtml(tool.name)}</code>` +
        `<span class="desc">${escapeHtml(tool.description ?? '')}</span></summary>` +
        `<pre class="text">${escapeHtml(schemaText(tool.parameters))}</pre></details>`,
    );
    parts.push(
      `<div class="tools"><div class="label">工具 ${tools.length} 个</div>${items.join('')}</div>`,
    );
  }

  const removed = message.toolsRemoved ?? [];
  if (removed.length > 0) {
    parts.push(
      `<div class="note">工具移除：${removed.map((tool) => escapeHtml(tool.name)).join(', ')}</div>`,
    );
  }

  if (parts.length === 0) parts.push('<pre class="text">（空的系统消息）</pre>');
  return parts;
}

/** 头部那条 system 消息的副标题：几段、几个工具（折叠着也能一眼看出有没有）。 */
function systemWho(message: SystemMessage): string {
  const bits: string[] = [];
  const sections = Object.values(message.sections ?? {}).filter((body) => typeof body === 'string').length;
  if (sections > 0) bits.push(`系统提示词 ${sections} 段`);
  const tools = message.toolsAdded?.length ?? 0;
  if (tools > 0) bits.push(`工具 ${tools} 个`);
  return bits.join(' · ');
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
  // 只数对话消息：请求头部那条 system 不是「这次会话说了几句」里的一句。
  const messages = info.lines.filter(
    (line) => line.kind === 'message' && (line.message as { role?: unknown }).role !== 'system',
  ).length;
  const body = info.lines.map(lineHtml).join('\n');
  const source =
    info.missing === true
      ? '找不到这个会话（文件被删了，或者不在这台机器的家目录里）'
      : info.file === null
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
  /* 请求头部（系统提示词分段 + 工具表）：一段 / 一个工具各一个 <details>，折叠着也看得见名字。 */
  .entry.system .entry-head .role { color: var(--accent); }
  details.fold { border-top: 1px solid var(--border); }
  details.fold > summary {
    display: flex; gap: 8px; align-items: baseline; padding: 6px 10px;
    color: var(--muted); font-size: 12px; cursor: pointer; list-style: none;
  }
  details.fold > summary::-webkit-details-marker { display: none; }
  details.fold > summary::before { content: '▸'; flex: none; }
  details.fold[open] > summary::before { content: '▾'; }
  details.fold > summary:hover { color: var(--text); }
  details.fold > summary code { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  details.fold > summary .size { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; }
  details.fold > summary .desc { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .tools { border-top: 1px solid var(--border); }
  .tools .label { padding: 6px 10px 0; font-size: 11px; color: var(--muted); }
  .tools .note { margin: 6px 10px; }
  /* 图片（read 读图 / 用户附件）：缩略图铺在卡片里，点一下用**另一层**看大图（见页尾脚本）。 */
  img.shot {
    display: block; max-width: 100%; max-height: 60vh; margin: 8px 10px;
    border: 1px solid var(--border); border-radius: 6px; background: #fff; cursor: zoom-in;
  }
  /*
   * 放大层：盖在页面上的一层，里面是**另一张** img。
   * 为什么不把原来那张改成 position: fixed —— 那样它就从文档流里抽走了，卡片上会
   * 留一个空洞、后面的内容整体上移：看着像「点一下把图删了」。原图必须待在原处。
   */
  .shot-overlay {
    position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
    padding: 4vh 4vw; background: rgb(0 0 0 / 0.72); cursor: zoom-out;
  }
  .shot-overlay img {
    max-width: 100%; max-height: 100%; border-radius: 6px; background: #fff;
    box-shadow: 0 8px 40px rgb(0 0 0 / 0.4);
  }
  /* 放大层开着时锁住底下的滚动（不然滚轮会把页面滚走，而看到的是盖住的那张图）。 */
  html.shot-open { overflow: hidden; }
  @media print {
    img.shot { max-height: none; }
    .shot-overlay { display: none; }
  }
  .empty { margin: 24px 0; color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>完整历史</h1>
  <div class="meta">会话 <code>${escapeHtml(info.sessionId)}</code>${
    info.cwd === '' ? '' : ` · 工作目录 <code>${escapeHtml(info.cwd)}</code>`
  }</div>
  <div class="meta">${
    info.missing === true ? '来源' : `${messages} 条消息 · 来源`
  } <code>${escapeHtml(source)}</code></div>
</header>
<main>
${body === '' ? `<p class="empty">${info.missing === true ? '找不到这个会话。' : '这次会话还没有内容。'}</p>` : body}
</main>
<script>
  // 点图放大：**另开一层**放一张同样的图，原来那张留在原地（它一动，卡片就会塌出一个洞）。
  // 关了就把那一层删掉，页面回到原样。Esc / 点任意处都能关。
  function openShot(source) {
    const overlay = document.createElement('div');
    overlay.className = 'shot-overlay';
    const big = document.createElement('img');
    // currentSrc 才是浏览器真正在显示的那一份（data: 原样带过来，不再嵌一次 base64）。
    big.src = source.currentSrc || source.src;
    big.alt = source.alt || '';
    overlay.appendChild(big);

    function close() {
      overlay.remove();
      document.documentElement.classList.remove('shot-open');
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    document.documentElement.classList.add('shot-open');
    document.body.appendChild(overlay);
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const image = target.closest('img.shot');
    if (image === null) return;
    openShot(image);
  });
</script>
</body>
</html>
`;
}
