/**
 * Action 的洋葱式 middleware。
 *
 * 这就是「Hooks」在本项目里的位置：**不是** system prompt 的附属品，而是一层横切所有
 * action 的拦截器。洋葱模型 —— 每个 middleware 在 action 前后各插手一次：
 *
 *   dispatch(action)
 *     → m1 前 ── m2 前 ── [reducer] ── m2 后 ── m1 后
 *
 * 为什么要这个形状：agent 里有些事必须在**状态变化之前**决定（改写 action、丢弃它），
 * 有些必须在**之后**做（审计、追加 prompt 片段、埋点）。prompt 装载就是后者的典型 ——
 * 一个 middleware 看到 `user.message` 就在其后 dispatch 一条 `prompt.segment.added`，
 * 它不需要知道 prompt 是什么，也不需要改 reducer。
 *
 * 现在是**骨架**：类型与洋葱语义都在，且有一个真实的中间件（`promptSegmentMiddleware`），
 * 但没有注册表、也没有挂进 dispatch 的时机 —— 那要等 store 层真正接上去。
 * 在那之前 middleware 只能被**手动**调用（`applyMiddleware`），这也是测试里唯一能
 * 证明语义正确的方式。
 */
import type { AgentAction } from './actions';
import type { AgentState } from './state';

export type Next = (action: AgentAction) => AgentState;

export interface ActionMiddleware {
  readonly name: string;
  /** action 进 reducer **之前**。返回替代的 action（改写）或 null（丢弃整条）。 */
  before?(action: AgentAction, state: AgentState): AgentAction | null;
  /** reducer 算完状态**之后**。返回要额外 dispatch 的 action（洋葱的「后」）。 */
  after?(
    action: AgentAction,
    nextState: AgentState,
    dispatch: (action: AgentAction) => void,
  ): void;
}

export interface MiddlewareOptions {
  /** 片段来源标记。给了就装载，没给就是「不追加」的默认内核。 */
  promptSource?: string | undefined;
}

/**
 * 洋葱式执行。
 *
 * `before` 正序（外 → 内，最后一个离 reducer 最近）；
 * `after` **逆序**（内 → 外），所以最外层最后收尾、看到的是最终状态。
 *
 * `next` 是「真正执行 reducer」那一步，由调用方注入 —— middleware 不该知道 reducer
 * 长什么样，也不该绕过 store 偷偷 dispatch。
 */
export function applyMiddleware(
  middlewares: readonly ActionMiddleware[],
  action: AgentAction,
  state: AgentState,
  next: (action: AgentAction) => AgentState,
  dispatch: (action: AgentAction) => void = () => undefined,
): AgentState {
  let current = action;
  for (const middleware of middlewares) {
    if (!middleware.before) continue;
    const replaced = middleware.before(current, state);
    if (replaced === null) return state; // 丢弃：reducer 与所有 after 都不跑
    current = replaced;
  }

  const nextState = next(current);

  for (let i = middlewares.length - 1; i >= 0; i -= 1) {
    middlewares[i]?.after?.(current, nextState, dispatch);
  }
  return nextState;
}

/**
 * 一个真实的中间件：**在用户发话之后追加一段 prompt 片段**。
 *
 * 它是「为什么要有 middleware」最好的例子：
 *   - 它关心的是「user.message 之后」，不是「prompt 是什么」；
 *   - 它不改 user.message 本身，只是多 dispatch 一条 `prompt.segment.added`；
 *   - reducer 因此完全不需要知道这个扩展点的存在。
 */
export function promptSegmentMiddleware(options: MiddlewareOptions): ActionMiddleware {
  const source = options.promptSource;
  return {
    name: 'prompt-segment',
    after(action, _nextState, dispatch) {
      if (action.type !== 'user.message') return;
      if (source === undefined) return;
      dispatch({
        type: 'prompt.segment.added',
        role: 'system',
        text: `（本轮由 ${source} 追加）`,
        source,
      });
    },
  };
}
