import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import {
  applyTraceRecord,
  computeNodeId,
  createTraceTree,
  renderTree,
  rootIdOf,
  shortId,
  type AgentAction,
} from '../src/index';
import {
  createTracePersistence,
  replaySession,
  TRACE_FILE_VERSION,
  upgradeTraceToV2,
  type TraceRecord,
  type TraceSink,
} from '../src/trace-store';
import type { ModelCapabilities } from '../src/actions';

// ── sha1：与 node:crypto 对拍（含填充边界） ──

test('sha1Hex 与 node:crypto 一致（含 55/56/64 字节填充边界与多字节字符）', async () => {
  const { sha1Hex } = await import('../src/sha1');
  const cases = [
    '',
    'abc',
    '你好，轨迹树',
    'x'.repeat(55),
    'y'.repeat(56),
    'z'.repeat(64),
    'w'.repeat(1000),
    JSON.stringify({ a: 1, b: '长'.repeat(500) }),
  ];
  for (const input of cases) {
    assert.equal(
      sha1Hex(input),
      createHash('sha1').update(input, 'utf8').digest('hex'),
      `输入长度 ${input.length} 应与 node:crypto 一致`,
    );
  }
});

// ── 节点 id：内容 hash ──

const CAPS: ModelCapabilities = {
  midConvoSystemMessages: true,
  midConvoToolAdditions: false,
  developerRole: false,
};

function seed(sessionId = 't'): AgentState {
  return createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId,
  });
}

function reduce(state: AgentState, action: AgentAction): AgentState {
  return createAgentReducer({})(state, action) as AgentState;
}

/** seed → prompt.init → model.init → 一句话（装载节点与 user 节点一次到位）。 */
function begun(text = '你好'): AgentState {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '你是助手', tools: [] });
  state = reduce(state, {
    type: 'model.init',
    provider: 'faux',
    modelId: 'fake',
    thinkingLevel: 'off',
    capabilities: CAPS,
  });
  return reduce(state, { type: 'user.message', text });
}

test('同一棵树回放重建后 id 一致；hash 里含时间戳（同 git，两次运行本就不同）', () => {
  const state = begun();
  for (const id of state.trace.order) {
    assert.match(id, /^[0-9a-f]{40}$/, `id 应是 40 位 sha1：${id}`);
  }
  // 同一棵树 serialize → deserialize → 逐条 applyTraceRecord，id 必须一字不变
  //（id 是内容寻址，树不变则 id 不变；而重跑一啣 action 的 createdAt 不同，
  //  hash 就不同 —— 与 git 的 commit hash 含时间戳同一语义）。
  let replayed = createTraceTree('t');
  for (const id of state.trace.order) {
    const node = state.trace.nodes[id];
    if (node) replayed = applyTraceRecord(replayed, node);
  }
  assert.deepEqual(replayed.order, state.trace.order);
  for (const id of state.trace.order) {
    assert.equal(replayed.nodes[id]?.id, id);
  }
});

test('树的根是 system prompt（role=system），其余节点全从它长出（单一根）', () => {
  const state = begun();
  const root = rootIdOf(state.trace);
  assert.ok(root);
  const rootNode = state.trace.nodes[root];
  assert.equal(rootNode?.kind, 'prompt.base', '根 = prompt.base');
  assert.equal(rootNode?.parentId, null, '根没有父节点');
  assert.equal(rootNode?.meta?.['role'], 'system', '根带着 role=system');

  // 除根外不允许第二棵根：每个节点的 parentId 都指向树里真实存在的节点。
  for (const id of state.trace.order) {
    const node = state.trace.nodes[id];
    assert.ok(node);
    if (node.id === root) continue;
    assert.ok(node.parentId !== null, `${node.kind} 不该是根`);
    assert.ok(state.trace.nodes[node.parentId], 'parentId 必须指向真实节点');
  }
  // 顺序：装载节点（prompt.base / prompt.tools / model.init）在 user 之前，user 挂在根下。
  const kinds = state.trace.order.map((id) => state.trace.nodes[id]?.kind);
  assert.deepEqual(kinds, ['prompt.base', 'prompt.tools', 'model.init', 'user']);
  const rootId = root;
  const userId = state.trace.order[3] ?? '';
  assert.equal(state.trace.nodes[userId]?.parentId, rootId, 'user 挂在 system 根下');
  assert.equal(state.trace.nodes[state.trace.order[2] ?? '']?.parentId, rootId, 'model.init 也挂在根下');
});

test('hash 由内容决定：改一个字段就换 id；序数区分内容相同的兄弟节点', () => {
  const base = {
    kind: 'user' as const,
    status: 'ok' as const,
    label: 'hi',
    createdAt: 1,
  };
  const a = computeNodeId(null, 1, base);
  const same = computeNodeId(null, 1, base);
  const otherOrdinal = computeNodeId(null, 2, base);
  const otherLabel = computeNodeId(null, 1, { ...base, label: 'yo' });
  const otherParent = computeNodeId('p', 1, base);
  assert.equal(a, same, '同内容同序数 → 同 hash');
  assert.notEqual(a, otherOrdinal, '序数参与 hash（内容相同的兄弟不撞车）');
  assert.notEqual(a, otherLabel, '内容参与 hash');
  assert.notEqual(a, otherParent, '父 id 参与 hash');
});

test('渲染行显示 7 位短 hash，全长留在数据层', () => {
  const state = begun();
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  for (const id of state.trace.order) {
    const short = shortId(id);
    assert.equal(short.length, 7);
    assert.ok(rendered.includes(short), `渲染行里有短 hash ${short}`);
    assert.ok(!rendered.includes(id), '渲染行不该出现全长 40 位');
  }
});

// ── 文件格式：版本头 + seq 严格等于行号 ──

/** 收集写进 sink 的所有行。 */
function memorySink(): TraceSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    append(line: string) {
      lines.push(line);
    },
  };
}

/** 最小 store：手推 reducer，订阅时通知落盘器（与真实 store 的语义一致）。 */
function harness() {
  const sink = memorySink();
  const reducer = createAgentReducer({});
  let state = seed('S');
  let notify: (() => void) | null = null;
  const dispatch = (action: AgentAction): void => {
    state = reducer(state, action) as AgentState;
    notify?.();
  };
  const store = {
    getState: () => state,
    subscribe: (listener: () => void): (() => void) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
    dispatch,
  };
  const persistence = createTracePersistence({ store, sink });
  return { sink, persistence, dispatch, getState: () => state };
}

const assistantMessage = (text: string): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
  }) as unknown as AssistantMessage;

test('v2 文件：首行版本头，之后每行 seq 严格等于行号', () => {
  const h = harness();
  h.dispatch({ type: 'prompt.init', systemPrompt: 'p', tools: [] });
  h.dispatch({ type: 'user.message', text: '你好' });
  h.dispatch({ type: 'agent.run' });
  h.dispatch({ type: 'llm.done', message: assistantMessage('好') });
  h.persistence.dispose();

  const lines = h.sink.lines.join('\n').split('\n').filter((l) => l.trim() !== '');
  lines.forEach((line, index) => {
    const record = JSON.parse(line) as TraceRecord;
    assert.equal(
      record.seq,
      index + 1,
      `第 ${index + 1} 行的 seq 应等于行号：${line.slice(0, 80)}`,
    );
  });
  const header = JSON.parse(lines[0] ?? '') as { op: string; v: number; seq: number };
  assert.equal(header.op, 'header');
  assert.equal(header.v, TRACE_FILE_VERSION);
  assert.equal(header.seq, 1, '版本头本身就是第 1 行');
});

test('v2 文件回放：树与消息重建，version 读出来是 2', () => {
  const h = harness();
  h.dispatch({ type: 'prompt.init', systemPrompt: 'p', tools: [] });
  h.dispatch({ type: 'user.message', text: '你好' });
  h.dispatch({ type: 'llm.done', message: assistantMessage('好') });
  h.persistence.dispose();

  const text = h.sink.lines.join('\n');
  const session = replaySession(text, 'S');
  assert.equal(session.version, TRACE_FILE_VERSION);
  assert.deepEqual(
    session.messages.map((m) => (m as { role: string }).role),
    ['user', 'assistant'],
  );
  assert.ok(session.tree.tipId, '回放后有 tip');
});

test('beginSession：续写已有文件时游标接在文件行数之后，不重复写版本头', () => {
  const h = harness();
  // 第一段会话写了几行。
  h.dispatch({ type: 'prompt.init', systemPrompt: 'p', tools: [] });
  h.dispatch({ type: 'user.message', text: '第一句' });
  const linesBefore = h.sink.lines.join('\n').split('\n').filter((l) => l.trim() !== '').length;

  // 模拟内核换会话：行游标拨到「文件现有行数 + 1」（这里 sink 没真落盘，行数即已写的行数）。
  h.persistence.beginSession({ nextLine: linesBefore + 1, headerPending: false, existingNodes: 0 });
  h.dispatch({ type: 'session.restored', message: { role: 'user', content: '旧历史', timestamp: 0 } });
  h.persistence.skipMessages(1);
  h.dispatch({ type: 'user.message', text: '新的一句' });
  h.persistence.dispose();

  const lines = h.sink.lines.join('\n').split('\n').filter((l) => l.trim() !== '');
  lines.forEach((line, index) => {
    const record = JSON.parse(line) as TraceRecord;
    assert.equal(record.seq, index + 1, `跨会话后 seq 仍要等于行号（第 ${index + 1} 行）`);
  });
  // 版本头只有第 1 行那一条：续写不再补头。
  const headers = lines.filter((l) => (JSON.parse(l) as { op?: string }).op === 'header');
  assert.equal(headers.length, 1);
  // 恢复进来的消息与它的 user 节点（已在文件里）不重写：新会话里只有新东西。
  const ops = lines.map((l) => (JSON.parse(l) as { op?: string }).op);
  assert.ok(ops.includes('header'));
});

test('beginSession：existingNodes 挡住「恢复出来的树被整棵重写一遍」', () => {
  // 第一段：正常写几行（prompt.base / prompt.tools / user 三个节点 + 一条消息）。
  const h = harness();
  h.dispatch({ type: 'prompt.init', systemPrompt: 'p', tools: [] });
  h.dispatch({ type: 'user.message', text: '第一句' });
  h.persistence.dispose();
  const restored = h.getState();

  // 第二段：与内核同款生命周期 —— 落盘器建在空树上（构造时的 flush 无东西可写），
  // beginSession 把游标拨到「文件末尾 + 已有节点数」之后，才把恢复的树灌进来。
  const sink2 = memorySink();
  let state: AgentState = seed('S');
  let notify: (() => void) | null = null;
  const persistence = createTracePersistence({
    store: {
      getState: () => state,
      subscribe: (l: () => void) => {
        notify = l;
        return () => {
          notify = null;
        };
      },
      dispatch: () => {},
    },
    sink: sink2,
  });
  persistence.beginSession({
    nextLine: 10,
    headerPending: false,
    existingNodes: restored.trace.order.length,
  });
  // 消息游标同样由内核拨：恢复出来的那条已在文件里。
  persistence.skipMessages(restored.messages.length);
  state = restored;
  const trigger = (): void => notify?.();
  trigger(); // 恢复落地：树与文件一致，不该写出任何行。
  assert.equal(sink2.lines.length, 0, '恢复出来的节点一个都不该重写');

  // 往恢复后的树上再长一个节点：只写新增的那一个，行号接着 10 往下数。
  state = reduce(restored, { type: 'queue.delivered', as: 'followUp', text: '新的一句' } as AgentAction);
  trigger();
  const written = sink2.lines.join('\n').split('\n').filter((l) => l.trim() !== '');
  for (const line of written) {
    const record = JSON.parse(line) as TraceRecord;
    assert.ok(record.seq >= 10, `续写行号从 beginSession 给的起点接着数：${line.slice(0, 60)}`);
  }
  persistence.dispose();
});

// ── v1 → v2 升级（纯函数） ──

const V1_TEXT = [
  '{"op":"prompt.init","systemPrompt":"p","tools":[]}',
  '{"op":"model.init","provider":"faux","modelId":"fake","thinkingLevel":"off","capabilities":{"midConvoSystemMessages":true,"midConvoToolAdditions":false,"developerRole":false}}',
  '{"op":"add","node":{"id":"n1","parentId":null,"kind":"prompt.base","status":"ok","label":"p","detail":"p","meta":{"role":"system"},"createdAt":1,"endedAt":1}}',
  '{"op":"add","node":{"id":"n2","parentId":"n1","kind":"prompt.tools","status":"ok","label":"（无）","createdAt":1,"endedAt":1}}',
  '{"op":"add","node":{"id":"n3","parentId":null,"kind":"user","status":"ok","label":"你好","createdAt":2,"endedAt":2}}',
  '{"op":"add","node":{"id":"n4","parentId":"n3","kind":"llm.result","status":"pending","label":"","createdAt":3}}',
  '{"op":"close","id":"n4","status":"ok","endedAt":4}',
  '{"op":"message","message":{"role":"user","content":"你好"}}',
  '{"op":"message","message":{"role":"assistant","content":"好"}}',
  '',
].join('\n');

test('upgradeTraceToV2：补版本头、逐行盖 seq、id 重算 hash、多根重挂到 system 根', () => {
  const { text, upgraded } = upgradeTraceToV2(V1_TEXT);
  assert.equal(upgraded, true);

  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const records = lines.map((l) => JSON.parse(l) as TraceRecord);
  records.forEach((record, index) => {
    assert.equal(record.seq, index + 1, `第 ${index + 1} 行 seq 应等于行号`);
  });
  assert.equal((records[0] as unknown as { op: string }).op, 'header');
  assert.equal((records[0] as unknown as { v: number }).v, 2);

  // 节点 id 全是 40 位 hash；父子引用一致地换过去。
  const adds = records.filter((r) => r.op === 'add');
  const idSet = new Set(adds.map((r) => (r.node as { id: string }).id));
  for (const record of adds) {
    const node = record.node as { id: string; parentId: string | null; kind: string };
    assert.match(node.id, /^[0-9a-f]{40}$/);
    if (node.parentId !== null) {
      assert.ok(idSet.has(node.parentId), `${node.kind} 的父必须是树里的节点`);
    }
  }
  // 单一根：只有 prompt.base 的 parentId 是 null，其余（包括旧对话族根 user）全挂它下面。
  const roots = adds.filter((r) => (r.node as { parentId: unknown }).parentId === null);
  assert.equal(roots.length, 1, 'v2 只允许一棵根');
  assert.equal((roots[0]?.node as { kind: string }).kind, 'prompt.base');
  const rootHash = (roots[0]?.node as { id: string }).id;
  const user = adds.find((r) => (r.node as { kind: string }).kind === 'user');
  assert.equal((user?.node as { parentId: string }).parentId, rootHash, '旧对话族根 user 重挂到 system 根');
  // close 引用的 id 也换了。
  const close = records.find((r) => r.op === 'close');
  assert.ok(close && idSet.has(close.id), 'close 的 id 指向升级后的 hash');
  // message 原样保留。
  const messages = records.filter((r) => r.op === 'message');
  assert.equal(messages.length, 2);

  // 回放升级后的文本：树能重建，tip 是闭合的 llm.result。
  const session = replaySession(text, 'S');
  assert.equal(session.version, 2);
  assert.equal(session.tree.order.length, 4);
});

test('upgradeTraceToV2：升级后的 id 与在线 computeNodeId 同源（同内容同 hash）', () => {
  const { text } = upgradeTraceToV2(V1_TEXT);
  const records = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TraceRecord);
  const base = records.find(
    (r): r is TraceRecord & { op: 'add' } => r.op === 'add' && r.node.kind === 'prompt.base',
  );
  assert.ok(base && base.node.kind === 'prompt.base');
  // 根：parentId=null、序数 1、内容与 v1 add 记录一致（含 role=system）→ hash 可复算。
  const expected = computeNodeId(null, 1, base.node);
  assert.equal(base.node.id, expected, '迁移的 hash 与在线路径同一套规范');
});

test('upgradeTraceToV2：已是 v2 原样返回；坏行丢弃', () => {
  const v2 = '{"seq":1,"op":"header","v":2}\n{"seq":2,"op":"message","message":{}}\n';
  const same = upgradeTraceToV2(v2);
  assert.equal(same.upgraded, false);
  assert.equal(same.text, v2);

  // 半行（崩溃截断）丢弃，其余照常升级。
  const { text, upgraded } = upgradeTraceToV2(
    `${V1_TEXT}{"op":"add","node":{"id":"n9"`,
  );
  assert.equal(upgraded, true);
  assert.equal(text.includes('n9'), false, '截断的半行不进新文件');
});
