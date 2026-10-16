#!/usr/bin/env python3
"""重建 `patches/@juicesharp__rpiv-ask-user-question@<版本>.patch`。

`ask_user_question` 是本项目的**内置扩展**：包是本仓库的 pinned 依赖，改动全在那份
patch 里（终端那份由扩展自己渲染、浏览器那份走 `ctx.ui.externalQuestionnaire` 交给
我们）。这个脚本就是那份 patch 的**可复现来源** —— 每一处改动下面都写着为什么，
升级上游时不用对着 diff 猜。

用法（仓库根目录，需要能访问 npm registry）：

    python3 scripts/repatch-ask-user-question.py

它做四件事：

1. 从 `packages/core/package.json` 读出 pin 的版本（版本只有一处，改那里）；
2. `npm pack` 拿**干净**的上游源码 —— 不能用 `pnpm patch` 解出来的那份：pnpm 会把
   **已经提交的 patch** 先应用上去，于是本脚本下面的 `sub()` 找不到原始片段；
3. 解包到 `node_modules/.pnpm_patches/<包名>@<版本>`，逐条应用改动；
4. `pnpm patch-commit <那个目录>` —— 生成 patch 文件、把 `patchedDependencies`
   登记进 `pnpm-workspace.yaml`、更新 lockfile。

升级上游的流程：改 `packages/core/package.json` 的版本 → 跑这个脚本。**对不上时
`sub()` 会指名道姓**（`找不到待替换的片段（哪一处）—— 上游改了？`），那就是上游动过
我们 patch 的地方，对着新代码改本脚本里的片段即可。跑完记得：

    pnpm --filter @ela/core test        # 含两条真扩展的端到端（浏览器先答 / 终端先答）
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

PACKAGE = "@juicesharp/rpiv-ask-user-question"
ROOT = Path(__file__).resolve().parent.parent


def read_pinned_version() -> str:
    core = json.loads((ROOT / "packages/core/package.json").read_text())
    version = core["dependencies"].get(PACKAGE)
    if not isinstance(version, str):
        sys.exit(f"packages/core/package.json 里没有 pin {PACKAGE}")
    return version


def fetch_pristine(version: str, into: Path) -> None:
    """把上游那一版的原始源码解到 `into`（干净、未打补丁）。"""
    subprocess.run(["npm", "pack", f"{PACKAGE}@{version}"], cwd=into, check=True, capture_output=True)
    tarballs = list(into.glob("*.tgz"))
    if len(tarballs) != 1:
        sys.exit(f"npm pack 没给出唯一 tarball：{[t.name for t in tarballs]}")
    with tarfile.open(tarballs[0]) as tar:
        tar.extractall(into, filter="data")


def main() -> None:
    version = read_pinned_version()
    target = ROOT / "node_modules/.pnpm_patches" / f"{PACKAGE}@{version}"
    print(f"{PACKAGE}@{version} → {target.relative_to(ROOT)}")

    with tempfile.TemporaryDirectory(prefix="ela-repatch-") as tmp:
        staging = Path(tmp)
        fetch_pristine(version, staging)
        # npm pack 解出来的是 package/ 那一层。
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staging / "package", target)

    apply_edits(target)
    subprocess.run(["pnpm", "patch-commit", str(target)], cwd=ROOT, check=True)
    print("patch 已生成；建议接着跑 `pnpm --filter @ela/core test`。")


def apply_edits(root: Path) -> None:
    patch_ask_user_question(root / "ask-user-question.ts")
    patch_i18n_bridge(root / "state/i18n-bridge.ts")
    patch_questionnaire_session(root / "state/questionnaire-session.ts")
    print("已应用：ask-user-question.ts / state/i18n-bridge.ts / state/questionnaire-session.ts")


def sub(text: str, old: str, new: str, why: str) -> str:
    if text.count(old) != 1:
        sys.exit(f"找不到待替换的片段（{why}）—— 上游改了？（出现 {text.count(old)} 次）")
    return text.replace(old, new, 1)


# ─────────────────────────────────────────────────────────────────────────────
# 一、ask-user-question.ts
# ─────────────────────────────────────────────────────────────────────────────


def patch_ask_user_question(path: Path) -> None:
    s = path.read_text()

    # ① import：getKeybindings（包装工厂要用）+ QuestionAnswer（翻译要用）
    s = sub(
        s,
        'import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";',
        'import {\n\tgetKeybindings,\n\tisKeyRelease,\n\tisKeyRepeat,\n\tmatchesKey,\n\ttype OverlayHandle,\n\ttype TUI,\n} from "@earendil-works/pi-tui";',
        "pi-tui import",
    )
    s = sub(
        s,
        "\tMAX_OPTIONS,\n\tMAX_QUESTIONS,\n\tMIN_OPTIONS,\n\ttype QuestionData,",
        "\tMAX_OPTIONS,\n\tMAX_QUESTIONS,\n\tMIN_OPTIONS,\n\ttype QuestionAnswer,\n\ttype QuestionData,",
        "types import",
    )

    # ② mountQuestionnaire：把这次的 `done` 与 session 交出去
    #    （宿主先答要收掉这次挂载；宿主同步备注要拿到 session）
    s = sub(
        s,
        """	collapseKey: string;
	presentation: Presentation;
	Session: SessionModule["QuestionnaireSession"];
}): Promise<QuestionnaireResult | undefined> {""",
        """	collapseKey: string;
	presentation: Presentation;
	Session: SessionModule["QuestionnaireSession"];
	/** ela patch：把这次的 `done` 交出去 —— 宿主（浏览器那份）先答时用它收掉这一次挂载。 */
	onDone?: (done: (result: QuestionnaireResult | undefined) => void) => void;
	/** ela patch：把这次建的 session 交出去 —— 宿主用它把"浏览器写的备注"同步进来。 */
	onSession?: (session: InstanceType<SessionModule["QuestionnaireSession"]>) => void;
}): Promise<QuestionnaireResult | undefined> {""",
        "mountQuestionnaire config",
    )
    s = sub(
        s,
        """	try {
		return await ctx.ui.custom<QuestionnaireResult>(
			makeSessionFactory({ ...config, canReopenWhileHidden, sessionRef }),""",
        """	try {
		// ela patch：包一层工厂，把 `done` / session 抓手留给上面那两个回调
		// （宿主先答时从外面收掉它；宿主写备注时同步进它）。
		const factory = makeSessionFactory({ ...config, canReopenWhileHidden, sessionRef });
		const wrapped =
			config.onDone === undefined && config.onSession === undefined
				? factory
				: (
						tui: TUI,
						theme: Theme,
						keybindings: ReturnType<typeof getKeybindings>,
						done: (result: QuestionnaireResult) => void,
					) => {
						config.onDone?.(done);
						const component = factory(tui, theme, keybindings, done);
						if (sessionRef.current !== null) config.onSession?.(sessionRef.current);
						return component;
					};
		return await ctx.ui.custom<QuestionnaireResult>(
			wrapped,""",
        "mountQuestionnaire factory wrap",
    )

    # ③ execute：宿主握手段（放在**会话懒加载之前** —— 浏览器那份不该等终端把
    #    pi-tui/markdown 那张重图导完）
    s = sub(
        s,
        "			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));",
        """			// ── ela patch：宿主（浏览器那一份）────────────────────────────────
			// 终端这一份仍然由我们自己画（下面 mount() → ctx.ui.custom）。ela 还会在
			// 浏览器里画同一份问卷：它实现了一个 `externalQuestionnaire` 接缝，我们把
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
			// 为什么放在懒加载**之前**：`loadQuestionnaireSession()` 要 import 终端那份
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

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));""",
        "handoff block",
    )

    # ④ 会话加载失败那条早退：也要把浏览器那份收掉（否则它一直挂着等人答）
    s = sub(
        s,
        """			if (!sessionLoad.ok) {
				return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
			}""",
        """			if (!sessionLoad.ok) {
				// ela patch：宿主那份（浏览器）已经开着 —— 这条早退也得把它收掉。
				if (externalStarted) external?.done?.();
				return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
			}""",
        "session load failure",
    )

    # ⑤ mount：把两个抓手接上
    s = sub(
        s,
        """			const mount = (p: Presentation) =>
				mountQuestionnaire({ ctx, typed, itemsByTab, collapseKey, presentation: p, Session: QuestionnaireSession });""",
        """			const mount = (p: Presentation) =>
				mountQuestionnaire({
					ctx,
					typed,
					itemsByTab,
					collapseKey,
					presentation: p,
					Session: QuestionnaireSession,
					onDone: claimDone,
					onSession: claimSession,
				});""",
        "mount helper",
    )
    # ⑥ 收尾：终端那一份结束了 → 让宿主把浏览器那份也收掉
    s = sub(
        s,
        """			} finally {
				presentation.release?.();
				emitAskUserBlockedEvent(pi, false);
			}""",
        """			} finally {
				presentation.release?.();
				emitAskUserBlockedEvent(pi, false);
				// 终端那一份结束了（答了 / 放弃了 / 报错了）—— 让宿主把浏览器那份收掉。
				// 幂等：浏览器先答时这一步是空转。
				if (externalStarted) external?.done?.();
			}""",
        "execute finally",
    )

    # ⑦ 尾部：握手类型 + 翻译（形状耦合留在包内）
    s = sub(
        s,
        "export { buildQuestionnaireResponse, buildToolResult };",
        """export { buildQuestionnaireResponse, buildToolResult };

// ── ela patch：宿主（浏览器那一份界面）能给的答案 ────────────────────────────
//
// 刻意做得"表面"一点：宿主只说它问了第几题、答的是哪个 label / 哪几个 label /
// 自定义原文、以及备注，**不需要**知道 QuestionnaireResult 长什么样。preview 这类
// 只有题目里才有的东西由这里回填（单选选项带 preview 时，envelope 会多一段
// `selected preview:`，那条是给模型看的，不能在浏览器那条路上丢掉）。
//
// 留空也是合法的：没答的题压根不出现在 `answers` 里 —— 信封那边会把它们列成
// `unanswered:`（partial submit），与扩展自己那份 TUI 对齐。

/** 一道题的表面答案。 */
export interface ExternalQuestionAnswer {
	questionIndex: number;
	kind: "option" | "custom" | "multi";
	/** `option` = 选项 label；`custom` = 自定义原文；`multi` 不用（看 selected）。 */
	answer?: string | null;
	/** `multi` 选中的那些 label。 */
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

/** `externalQuestionnaire` 接缝的载荷。 */
export interface ExternalQuestionnaireHandoff {
	params: QuestionParams;
	/** 浏览器先答：把答案给过来（简单形状），我们自己收掉终端那份并继续。 */
	answer: (raw: ExternalQuestionnaireAnswer) => void;
	/** 浏览器写了某题的备注：同步进这次 session（`tab` 就是题号，最后一个是整份备注）。 */
	note: (tab: number, text: string) => void;
	/** 终端那一份结束了：宿主把浏览器那份收掉。幂等。 */
	done: () => void;
}

/** 宿主那次调用拿到的东西（现在什么也不用回，留着给以后加能力）。 */
export interface ExternalQuestionnaireBridge {
	done?: () => void;
}

/** 把表面答案翻成 `QuestionnaireResult`（preview 从题目里回填）。 */
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
}""",
        "tail helpers",
    )

    path.write_text(s)


# ─────────────────────────────────────────────────────────────────────────────
# 二、state/i18n-bridge.ts —— 去掉顶层 await
# ─────────────────────────────────────────────────────────────────────────────


def patch_i18n_bridge(path: Path) -> None:
    s = path.read_text()
    s = sub(
        s,
        """let scopeImpl: ScopeFn;
try {
	const sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
	scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
	scopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;""",
        """// ela patch：这里**不能**用顶层 await。
//
// 上游是 TLA（`await import("@juicesharp/rpiv-i18n")`），而 pi 的 loader 走 jiti：
// TLA 还没结算时，**导入这个模块的模块**拿到的 namespace 里，导出还是 undefined ——
// 症状是 `loadQuestionnaireSession()` 读到 `typeof mod.QuestionnaireSession !== "function"`，
// 于是扩展对模型说"这个工具坏了，重启 Pi"（负载高时必现，而且同一个进程里第一次加载
// 就中招 —— jiti 的模块图缓存随后一直带着这个坏 namespace）。
//
// 改成"先给同步兜底、SDK 到了再换"：`t()` 每次调用现读 `scopeImpl`，语义与上游一致
// （SDK 装了就实时跟 locale），只是不再把整条模块图卡在一个 await 上。
let scopeImpl: ScopeFn = (_key, fallback) => fallback;
void import("@juicesharp/rpiv-i18n")
	.then((sdk) => {
		scopeImpl = (sdk as I18nSDK).scope(I18N_NAMESPACE);
	})
	.catch(() => {
		// 没装 SDK：保持英文兜底（与上游同一条降级路）。
	});

export const t: ScopeFn = (key, fallback) => scopeImpl(key, fallback);""",
        "i18n TLA",
    )
    s = sub(
        s,
        """// Top-level await is required so a synchronous `t(...)` call from any
// downstream module sees the resolved scope; ESM module loading awaits this
// before evaluating any importer.""",
        """// ela patch: 上游这里写着"必须有顶层 await，否则下游的同步 t(...) 看不到已解析的
// scope"—— 在真 ESM 里成立，但 pi 的 loader 走 jiti，TLA 反而会让导入方读到
// undefined（见下面那段注释）。这里用"先兜底、再替换"达到同一个目的。""",
        "i18n TLA comment",
    )
    path.write_text(s)


# ─────────────────────────────────────────────────────────────────────────────
# 三、state/questionnaire-session.ts —— 让宿主能把备注同步进来
# ─────────────────────────────────────────────────────────────────────────────


def patch_questionnaire_session(path: Path) -> None:
    s = path.read_text()
    s = sub(
        s,
        """	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {""",
        """	/**
	 * ela patch：宿主（浏览器那一份界面）把它的备注同步进来。
	 *
	 * 走的是同一份状态：写进 `notesByTab`（上游那份"预先写好的备注"侧带，键就是题号，
	 * 最后一个是整份备注）再刷新视图 —— 于是终端这边**看得见**同一条备注，而且万一
	 * 最后是终端提交的，那条备注照样跟着答案回给模型（浏览器那份没白写）。
	 *
	 * 反向（终端 → 浏览器）没有通道：终端那份备注在扩展自己组件里，宿主读不到 ——
	 * 见 `docs/architecture/extensions.md` 的"备注只同步一个方向"。
	 */
	setHostNote(tab: number, text: string): void {
		const trimmed = text.trim();
		const existing = this.state.notesByTab.get(tab) ?? "";
		if (existing === (trimmed === "" ? "" : text)) return;
		const next = new Map(this.state.notesByTab);
		if (trimmed === "") next.delete(tab);
		else next.set(tab, text);
		this.state = { ...this.state, notesByTab: next };
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {""",
        "setHostNote",
    )
    path.write_text(s)


if __name__ == "__main__":
    main()