/**
 * 界面文案的**唯一出口**（i18n）。
 *
 * ## 为什么要有它
 *
 * 文案此前散在各处且中英混杂：停止原因在 `state.ts` 的 `stopCauseText()`（中文）、
 * 超时消息在 `effects.ts` 里手拼（中文）、思考折叠行是传给 pi 组件的 `'Thinking…'`
 * （英文）、中止收尾由 pi 的组件自己画（`Operation aborted`，英文）。同一种失败
 * （超时）一会儿「大模型调用超时」一会儿「LLM 调用超时」，中断一会儿中文一会儿
 * `Operation aborted` —— 用户看到的是同一个界面在说两种话。
 *
 * 规则：**凡是要显示给人看的句子都从这里取**（`t('key')`），代码里不再出现裸的
 * 中/英文案。轨迹树、日志里的错误原文（provider 原话）不属于界面文案，照旧落盘，
 * 排查不受影响。
 *
 * 语言：默认中文；`ELA_LANG=en` 环境变量或 `setLang('en')` 可切英文。文案表只有
 * zh / en 两份 —— 第三种语言等真有需求再加。
 */

/** 支持的语言。 */
export type Lang = 'zh' | 'en';

let current: Lang = readEnvLang();

function readEnvLang(): Lang {
  const raw = process.env['ELA_LANG']?.trim().toLowerCase();
  return raw === 'en' ? 'en' : 'zh';
}

/** 当前语言（默认 zh，`ELA_LANG` 可覆盖）。 */
export function getLang(): Lang {
  return current;
}

/** 切换语言（测试与将来的设置入口用；文案在下一次 `t()` 生效）。 */
export function setLang(lang: Lang): void {
  current = lang;
}

type Dict = Record<string, string>;

const zh: Dict = {
  // ── 停止原因（一句人话，原 stopCauseText）──
  'stopCause.completed': '模型自己说完了',
  'stopCause.maxTurns': '已达单回合轮数上限',
  'stopCause.user': '用户手动中断',
  'stopCause.timeout': '大模型调用超时',
  'stopCause.network': '网络错误',
  'stopCause.auth': '鉴权失败（API key 无效或无权限）',
  'stopCause.model': '模型侧报错',
  'stopCause.llmError': '大模型调用失败',
  'stopCause.toolError': '工具批次整体失败',
  'stopCause.shutdown': '被内核关闭',
  'stopCause.compactError': '上下文压缩失败（对话原样保留）',
  // ── 超时（effects 抛的异常消息；时长由 formatDuration 产出）──
  'timeout.withDuration': '大模型调用超时（{duration}）',
  // ── 助手消息的思考折叠行（传给 pi 组件的占位标签）──
  'thinking.label': '思考中…',
  // ── 助手消息收尾（pi 组件那三句英文的替代，逻辑与它一致）──
  'assistant.aborted': '操作已中止',
  'assistant.abortedWithReason': '操作已中止：{reason}',
  'assistant.truncated': '回答在完成前被截断。',
  'assistant.error': '错误：{message}',
  'assistant.unknownError': '未知错误',
  // ── 快捷键反馈行 ──
  'notify.toolOutput.expanded': '工具输出：展开',
  'notify.toolOutput.collapsed': '工具输出：折叠',
  'notify.thinkingBlocks.hidden': '思考块：已折叠',
  'notify.thinkingBlocks.visible': '思考块：已展开',
  'notify.thinking.unsupported': '当前模型不支持思考',
  'notify.model.onlyOneInScope': '作用域里只有一个模型',
  'notify.model.onlyOneAvailable': '只有一个可用模型',
};

const en: Dict = {
  'stopCause.completed': 'Model finished on its own',
  'stopCause.maxTurns': 'Turn limit reached',
  'stopCause.user': 'Interrupted by user',
  'stopCause.timeout': 'LLM call timed out',
  'stopCause.network': 'Network error',
  'stopCause.auth': 'Authentication failed (invalid or unauthorized API key)',
  'stopCause.model': 'Model-side error',
  'stopCause.llmError': 'LLM call failed',
  'stopCause.toolError': 'Tool batch failed',
  'stopCause.shutdown': 'Shut down by kernel',
  'stopCause.compactError': 'Context compaction failed (conversation kept as-is)',
  'timeout.withDuration': 'LLM call timed out ({duration})',
  'thinking.label': 'Thinking…',
  'assistant.aborted': 'Operation aborted',
  'assistant.abortedWithReason': 'Operation aborted: {reason}',
  'assistant.truncated': 'Response was truncated before completion.',
  'assistant.error': 'Error: {message}',
  'assistant.unknownError': 'Unknown error',
  'notify.toolOutput.expanded': 'Tool output: expanded',
  'notify.toolOutput.collapsed': 'Tool output: collapsed',
  'notify.thinkingBlocks.hidden': 'Thinking blocks: hidden',
  'notify.thinkingBlocks.visible': 'Thinking blocks: visible',
  'notify.thinking.unsupported': 'Current model does not support thinking',
  'notify.model.onlyOneInScope': 'Only one model in scope',
  'notify.model.onlyOneAvailable': 'Only one model available',
};

const dicts: Record<Lang, Dict> = { zh, en };

/**
 * 取一句文案。`params` 做 `{name}` 占位替换 —— 只此一种，不引格式化库。
 *
 * key 缺失是**编程错误**（拼错 key 比显示 key 本身更糟）：直接抛，测试当场抓住。
 */
export function t(key: string, params?: Record<string, string>): string {
  const text = dicts[current][key] ?? zh[key];
  if (text === undefined) throw new Error(`[i18n] 缺少文案 key：${key}`);
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? params[name]! : whole,
  );
}
