/**
 * 重建 `patches/@juicesharp__rpiv-ask-user-question@<版本>.patch`。
 *
 * 留着可执行的来源是因为**反向重建**太麻烦：`ask_user_question` 是内置扩展，我们对它的全部改动都在
 * 那份 patch 里，上游升级时要靠人对着 diff 猜。这里一处改动一段代码、旁边写着为什么，跑一遍就重建。
 *
 * 四条路：从 `packages/core/package.json` 读 pin 的版本（**版本只有那一处**）→ `npm pack` 拿**干净**
 * 的上游源码（不能用 `pnpm patch` 解出来的那份：pnpm 会先把已提交的 patch 应用上去，于是 `sub()`
 * 找不到原始片段）→ 解到 `node_modules/.pnpm_patches/<包名>@<版本>` 逐条应用 → `pnpm patch-commit`
 * 生成 patch 并登记 `patchedDependencies`。
 *
 * 升级上游：改版本号 → 跑这个脚本。上游动过我们 patch 的地方会对不上，`sub()` 会**指名道姓**报
 * 「找不到待替换的片段」，对着新代码改下面那段即可。跑完接着 `pnpm --filter @ela/core test`
 * （那里有两条真扩展的端到端：浏览器先答 / 终端先答）。
 *
 * 依赖：`npm`（取包）与 `tar`（解包）。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@juicesharp/rpiv-ask-user-question';
/** 仓库根（这个文件在 `packages/core/scripts/`）。 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 一条替换：`old` 必须在全文里**唯一**出现，否则视为上游改了。 */
function sub(text: string, old: string, next: string, why: string): string {
  const hits = text.split(old).length - 1;
  if (hits !== 1) {
    throw new Error(`找不到待替换的片段（${why}）—— 上游改了？（出现 ${hits} 次）`);
  }
  return text.replace(old, next);
}

function pinnedVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'packages/core/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const version = manifest.dependencies?.[PACKAGE];
  if (typeof version !== 'string') throw new Error(`packages/core/package.json 里没有 pin ${PACKAGE}`);
  return version;
}

/** 把上游那一版的**原始**源码解到 `target`。 */
function fetchPristine(version: string, target: string): void {
  const staging = mkdtempSync(path.join(tmpdir(), 'ela-repatch-'));
  try {
    execFileSync('npm', ['pack', `${PACKAGE}@${version}`], { cwd: staging, stdio: 'inherit' });
    const tarballs = readdirSync(staging).filter((name) => name.endsWith('.tgz'));
    const tarball = tarballs[0];
    if (tarballs.length !== 1 || tarball === undefined) {
      throw new Error(`npm pack 没给出唯一 tarball：${tarballs.join(', ')}`);
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    // tarball 里是 `package/…` 那一层 —— strip 掉它。
    execFileSync('tar', ['-xzf', path.join(staging, tarball), '-C', target, '--strip-components=1'], {
      stdio: 'inherit',
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * 一处改动：`ask-user-question.ts` —— 宿主（浏览器那一份）的接缝。
 *
 * 三条通道：`answer`（浏览器先答）/ `note`（浏览器写的备注同步进来）/ `done`（终端那份结束）。
 * 另外把 `done` 与 session 抓手从 `mountQuestionnaire` 里引出来。
 */
function patchAskUserQuestion(root: string): void {
  const file = path.join(root, 'ask-user-question.ts');
  let s = readFileSync(file, 'utf8');

  // ① import：`getKeybindings`（包装工厂要用）+ `QuestionAnswer`（翻译要用）
  s = sub(
    s,
    'import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";',
    'import {\n\tgetKeybindings,\n\tisKeyRelease,\n\tisKeyRepeat,\n\tmatchesKey,\n\ttype OverlayHandle,\n\ttype TUI,\n} from "@earendil-works/pi-tui";',
    'pi-tui import',
  );
  s = sub(
    s,
    '\tMAX_OPTIONS,\n\tMAX_QUESTIONS,\n\tMIN_OPTIONS,\n\ttype QuestionData,',
    '\tMAX_OPTIONS,\n\tMAX_QUESTIONS,\n\tMIN_OPTIONS,\n\ttype QuestionAnswer,\n\ttype QuestionData,',
    'types import',
  );

  // ② mountQuestionnaire：把 `done` 与 session 交给调用方
  //    （宿主先答要收掉这次挂载；宿主同步备注要拿到 session）
  s = sub(
    s,
    `\tcollapseKey: string;
\tpresentation: Presentation;
\tSession: SessionModule["QuestionnaireSession"];
}): Promise<QuestionnaireResult | undefined> {`,
    `\tcollapseKey: string;
\tpresentation: Presentation;
\tSession: SessionModule["QuestionnaireSession"];
\t/** ela patch：把这次的 \`done\` 交出去 —— 宿主（浏览器那份）先答时用它收掉这一次挂载。 */
\tonDone?: (done: (result: QuestionnaireResult | undefined) => void) => void;
\t/** ela patch：把这次建的 session 交出去 —— 宿主用它把"浏览器写的备注"同步进来。 */
\tonSession?: (session: InstanceType<SessionModule["QuestionnaireSession"]>) => void;
}): Promise<QuestionnaireResult | undefined> {`,
    'mountQuestionnaire config',
  );
  s = sub(
    s,
    `\ttry {
\t\treturn await ctx.ui.custom<QuestionnaireResult>(
\t\t\tmakeSessionFactory({ ...config, canReopenWhileHidden, sessionRef }),`,
    `\ttry {
\t\t// ela patch：包一层工厂，把 \`done\` / session 抓手留给上面那两个回调
\t\t// （宿主先答时从外面收掉它；宿主写备注时同步进它）。
\t\tconst factory = makeSessionFactory({ ...config, canReopenWhileHidden, sessionRef });
\t\tconst wrapped =
\t\t\tconfig.onDone === undefined && config.onSession === undefined
\t\t\t\t? factory
\t\t\t\t: (
\t\t\t\t\t\ttui: TUI,
\t\t\t\t\t\ttheme: Theme,
\t\t\t\t\t\tkeybindings: ReturnType<typeof getKeybindings>,
\t\t\t\t\t\tdone: (result: QuestionnaireResult) => void,
\t\t\t\t\t) => {
\t\t\t\t\t\tconfig.onDone?.(done);
\t\t\t\t\t\tconst component = factory(tui, theme, keybindings, done);
\t\t\t\t\t\tif (sessionRef.current !== null) config.onSession?.(sessionRef.current);
\t\t\t\t\t\treturn component;
\t\t\t\t\t};
\t\treturn await ctx.ui.custom<QuestionnaireResult>(
\t\t\twrapped,`,
    'mountQuestionnaire factory wrap',
  );

  // ③ execute：握手段。放在**会话懒加载之前** —— 浏览器那份弹窗不该等终端把
  //    pi-tui/markdown 那张重图导完（冷导入约 1s，负载高时更久）。
  s = sub(
    s,
    '			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));',
    `			// ── ela patch：宿主（浏览器那一份）────────────────────────────────
			// 终端这一份仍然由我们自己画（下面 mount() → ctx.ui.custom）。ela 还会在
			// 浏览器里画同一份问卷：它实现了一个 \`externalQuestionnaire\` 接缝，我们把
			// 题目交出去（形状耦合留在包内 —— 它只回 label / selected / notes 这些表面
			// 东西），并给它三个动作：
			//
			//   answer(raw)      浏览器先答 → 用它把这一次挂载收掉（当作终端那边答完了）
			//   note(i, text)    浏览器写了备注 → 同步进这次 session（终端那份也看得到，
			//                    而且万一是终端提交的，那条备注照样跟着答案回给模型）
			//   done()           终端这一份结束了 → 宿主收掉浏览器那份
			//
			// 谁先答都算数，两边都不用猜对方的状态。宿主没有这个接缝时（别的宿主、
			// 老版本）全是 undefined，下面一切照旧。
			//
			// 为什么绕这一圈而不是让宿主直接 resolve 我们的 promise：那样宿主得猜
			// "紧随其后的那次 ctx.ui.custom 是不是这份问卷的"——并行工具调用一来就会认错。
			// 这里由我们自己收自己的挂载，宿主只负责画、答、同步备注。
			//
			// 为什么放在懒加载**之前**：\`loadQuestionnaireSession()\` 要 import 终端那份
			// 渲染图（pi-tui 组件、markdown……冷导入约 1s，负载高时更久）。浏览器那份
			// 弹窗不该等它 —— 早先放在后面，结果是"浏览器要等终端把重图导完才出现"。
			let finish: ((result: QuestionnaireResult) => void) | undefined;
			let heldExternal: QuestionnaireResult | undefined;
			let externalClosed = false;
			let noteTarget: InstanceType<SessionModule["QuestionnaireSession"]> | undefined;
			const applyHeld = (): void => {
				if (heldExternal === undefined || finish === undefined) return;
				const result = heldExternal;
				heldExternal = undefined;
				finish(result);
			};
			const claimDone = (done: (result: QuestionnaireResult) => void): void => {
				finish = done;
				applyHeld();
			};
			const claimSession = (
				session: InstanceType<SessionModule["QuestionnaireSession"]>,
			): void => {
				noteTarget = session;
			};
			const externalHost = (
				ctx.ui as {
					externalQuestionnaire?: (
						handoff: ExternalQuestionnaireHandoff,
					) => ExternalQuestionnaireBridge | undefined;
				}
			).externalQuestionnaire;
			const externalStarted = externalHost !== undefined;
			const external = externalHost?.({
				params: typed,
				answer: (raw) => {
					if (externalClosed) return;
					heldExternal = toExternalResult(raw, typed);
					applyHeld();
				},
				note: (index, text) => {
					noteTarget?.setHostNote(index, text);
				},
				done: () => {
					externalClosed = true;
				},
			});

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));`,
    'handoff block',
  );

  // ④ 会话加载失败那条早退：也要把浏览器那份收掉（否则它一直挂着等人答）
  s = sub(
    s,
    `			if (!sessionLoad.ok) {
				return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
			}`,
    `			if (!sessionLoad.ok) {
				// ela patch：宿主那份（浏览器）已经开着 —— 这条早退也得把它收掉。
				if (externalStarted) external?.done?.();
				return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
			}`,
    'session load failure',
  );

  // ⑤ mount：把两个抓手接上
  s = sub(
    s,
    `			const mount = (p: Presentation) =>
				mountQuestionnaire({ ctx, typed, itemsByTab, collapseKey, presentation: p, Session: QuestionnaireSession });`,
    `			const mount = (p: Presentation) =>
				mountQuestionnaire({
					ctx,
					typed,
					itemsByTab,
					collapseKey,
					presentation: p,
					Session: QuestionnaireSession,
					onDone: claimDone,
					onSession: claimSession,
				});`,
    'mount helper',
  );

  // ⑥ 收尾：终端那一份结束了 → 让宿主把浏览器那份也收掉
  s = sub(
    s,
    `			} finally {
				presentation.release?.();
				emitAskUserBlockedEvent(pi, false);
			}`,
    `			} finally {
				presentation.release?.();
				emitAskUserBlockedEvent(pi, false);
				// 终端那一份结束了（答了 / 放弃了 / 报错了）—— 让宿主把浏览器那份收掉。
				// 幂等：浏览器先答时这一步是空转。
				if (externalStarted) external?.done?.();
			}`,
    'execute finally',
  );

  // ⑦ 尾部：握手的类型 + 翻译（形状耦合留在包内）
  s = sub(
    s,
    'export { buildQuestionnaireResponse, buildToolResult };',
    `export { buildQuestionnaireResponse, buildToolResult };

// ── ela patch：宿主（浏览器那一份界面）能给的答案 ────────────────────────────
//
// 刻意做得"表面"一点：宿主只说它问了第几题、答的是哪个 label / 哪几个 label /
// 自定义原文、以及备注，**不需要**知道 QuestionnaireResult 长什么样。preview 这类
// 只有题目里才有的东西由这里回填（单选选项带 preview 时，envelope 会多一段
// \`selected preview:\`，那条是给模型看的，不能在浏览器那条路上丢掉）。
//
// 留空也是合法的：没答的题压根不出现在 \`answers\` 里 —— 信封那边会把它们列成
// \`unanswered:\`（partial submit），与扩展自己那份 TUI 对齐。

/** 一道题的表面答案。 */
export interface ExternalQuestionAnswer {
	questionIndex: number;
	kind: "option" | "custom" | "multi";
	/** \`option\` = 选项 label；\`custom\` = 自定义原文；\`multi\` 不用（看 selected）。 */
	answer?: string | null;
	/** \`multi\` 选中的那些 label。 */
	selected?: string[];
	/** 用户写的备注（可空）。 */
	notes?: string;
}

/** 宿主交给我们的答案（整份）。 */
export interface ExternalQuestionnaireAnswer {
	answers: ExternalQuestionAnswer[];
	/** 用户放弃整份问卷。 */
	cancelled?: boolean;
	/** 提交页上那句"整份备注"。 */
	globalNote?: string;
}

/** \`externalQuestionnaire\` 接缝的载荷。 */
export interface ExternalQuestionnaireHandoff {
	params: QuestionParams;
	/** 浏览器先答：把答案给过来（简单形状），我们自己收掉终端那份并继续。 */
	answer: (raw: ExternalQuestionnaireAnswer) => void;
	/** 浏览器写了某题的备注：同步进这次 session（\`tab\` 就是题号，最后一个是整份备注）。 */
	note: (tab: number, text: string) => void;
	/** 终端那一份结束了：宿主把浏览器那份收掉。幂等。 */
	done: () => void;
}

/** 宿主那次调用拿到的东西（现在什么也不用回，留着给以后加能力）。 */
export interface ExternalQuestionnaireBridge {
	done?: () => void;
}

/** 把表面答案翻成 \`QuestionnaireResult\`（preview 从题目里回填）。 */
export function toExternalResult(raw: ExternalQuestionnaireAnswer, params: QuestionParams): QuestionnaireResult {
	const note = (text: string | undefined): { notes?: string } =>
		text !== undefined && text.trim() !== "" ? { notes: text } : {};
	const globalNote =
		raw.globalNote !== undefined && raw.globalNote.trim() !== "" ? { globalNote: raw.globalNote } : {};
	if (raw.cancelled === true) {
		return { answers: [], cancelled: true, ...globalNote };
	}
	const answers: QuestionAnswer[] = [];
	for (const item of raw.answers ?? []) {
		const question = params.questions[item.questionIndex];
		if (question === undefined) continue;
		const base = { questionIndex: item.questionIndex, question: question.question, ...note(item.notes) };
		if (item.kind === "multi") {
			answers.push({ ...base, kind: "multi", answer: null, selected: item.selected ?? [] });
			continue;
		}
		if (item.kind === "custom") {
			answers.push({ ...base, kind: "custom", answer: item.answer ?? "" });
			continue;
		}
		const option = question.options.find((o) => o.label === item.answer);
		if (option === undefined) continue;
		answers.push({
			...base,
			kind: "option",
			answer: option.label,
			...(option.preview !== undefined && option.preview.length > 0 ? { preview: option.preview } : {}),
		});
	}
	return { answers, cancelled: false, ...globalNote };
}`,
    'tail helpers',
  );

  writeFileSync(file, s);
}

/**
 * 一处改动：`state/i18n-bridge.ts` —— 去掉顶层 await。
 *
 * 上游那句 TLA 在 jiti 下会让**导入它的模块**拿到 `undefined` 导出，症状是扩展对模型说
 * 「这个工具坏了，请重启」。
 */
function patchI18nBridge(root: string): void {
  const file = path.join(root, 'state/i18n-bridge.ts');
  let s = readFileSync(file, 'utf8');
  s = sub(
    s,
    `let scopeImpl: ScopeFn;
try {
\tconst sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
\tscopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
\tscopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;`,
    `// ela patch：这里**不能**用顶层 await。
//
// 上游是 TLA（\`await import("@juicesharp/rpiv-i18n")\`），而 pi 的 loader 走 jiti：
// TLA 还没结算时，**导入这个模块的模块**拿到的 namespace 里，导出还是 undefined ——
// 症状是 \`loadQuestionnaireSession()\` 读到 \`typeof mod.QuestionnaireSession !== "function"\`，
// 于是扩展对模型说"这个工具坏了，重启 Pi"（负载高时必现，而且同一个进程里第一次加载
// 就中招 —— jiti 的模块图缓存随后一直带着这个坏 namespace）。
//
// 改成"先给同步兜底、SDK 到了再换"：\`t()\` 每次调用现读 \`scopeImpl\`，语义与上游一致
// （SDK 装了就实时跟 locale），只是不再把整条模块图卡在一个 await 上。
let scopeImpl: ScopeFn = (_key, fallback) => fallback;
void import("@juicesharp/rpiv-i18n")
\t.then((sdk) => {
\t\tscopeImpl = (sdk as I18nSDK).scope(I18N_NAMESPACE);
\t})
\t.catch(() => {
\t\t// 没装 SDK：保持英文兜底（与上游同一条降级路）。
\t});

export const t: ScopeFn = (key, fallback) => scopeImpl(key, fallback);`,
    'i18n TLA',
  );
  s = sub(
    s,
    `// Top-level await is required so a synchronous \`t(...)\` call from any
// downstream module sees the resolved scope; ESM module loading awaits this
// before evaluating any importer.`,
    `// ela patch: 上游这里写着"必须有顶层 await，否则下游的同步 t(...) 看不到已解析的
// scope"—— 在真 ESM 里成立，但 pi 的 loader 走 jiti，TLA 反而会让导入方读到
// undefined（见下面那段注释）。这里用"先兜底、再替换"达到同一个目的。`,
    'i18n TLA comment',
  );
  writeFileSync(file, s);
}

/**
 * 一处改动：`state/questionnaire-session.ts` —— 让宿主能把备注同步进来。
 *
 * 写进上游那份"预先写好的备注"侧带 `notesByTab`（键就是题号，最后一个是整份备注），
 * 于是终端那边看得见同一条，而且万一是终端提交的，备注照样跟着答案回给模型。
 */
function patchQuestionnaireSession(root: string): void {
  const file = path.join(root, 'state/questionnaire-session.ts');
  let s = readFileSync(file, 'utf8');
  s = sub(
    s,
    '\tprivate mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {',
    `\t/**
\t * ela patch：宿主（浏览器那一份界面）把它的备注同步进来。
\t *
\t * 走的是同一份状态：写进 \`notesByTab\`（上游那份"预先写好的备注"侧带，键就是题号，
\t * 最后一个是整份备注）再刷新视图 —— 于是终端这边**看得见**同一条备注，而且万一
\t * 最后是终端提交的，那条备注照样跟着答案回给模型（浏览器那份没白写）。
\t *
\t * 反向（终端 → 浏览器）没有通道：终端那份备注在扩展自己组件里，宿主读不到 ——
\t * 见 \`docs/architecture/extensions.md\` 的"备注只同步一个方向"。
\t */
\tsetHostNote(tab: number, text: string): void {
\t\tconst trimmed = text.trim();
\t\tconst existing = this.state.notesByTab.get(tab) ?? "";
\t\tif (existing === (trimmed === "" ? "" : text)) return;
\t\tconst next = new Map(this.state.notesByTab);
\t\tif (trimmed === "") next.delete(tab);
\t\telse next.set(tab, text);
\t\tthis.state = { ...this.state, notesByTab: next };
\t\tthis.viewAdapter.apply(this.state);
\t}

\tprivate mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {`,
    'setHostNote',
  );
  writeFileSync(file, s);
}

function main(): void {
  const version = pinnedVersion();
  const target = path.join(ROOT, 'node_modules/.pnpm_patches', `${PACKAGE}@${version}`);
  console.log(`${PACKAGE}@${version} → ${path.relative(ROOT, target)}`);

  fetchPristine(version, target);
  patchAskUserQuestion(target);
  patchI18nBridge(target);
  patchQuestionnaireSession(target);
  console.log('已应用：ask-user-question.ts / state/i18n-bridge.ts / state/questionnaire-session.ts');

  execFileSync('pnpm', ['patch-commit', target], { cwd: ROOT, stdio: 'inherit' });
  console.log('patch 已生成；建议接着跑 `pnpm --filter @ela/core test`。');
}

main();