import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { StreamLineDecoder } from './stream-parser.js';
import {
  emptyTurn,
  foldParts,
  genMessageId,
  parseCommand,
  type TurnView,
  type TuiCommand,
} from './utils.js';

export interface TuiProps {
  serverUrl: string;
  cwd: string;
}

interface HistoryItem {
  role: 'user' | 'assistant' | 'note';
  text: string;
}

/** The approval surface mode during a paused turn (ticket 07). */
type PendingMode = 'yesno' | 'answer' | null;

/**
 * The Claude Code-style core session loop (ADR-0017 tickets 06–07): bottom
 * input (Enter sends, Shift+Enter newline), streamed assistant text rendered
 * inline, tool calls as compact cards. Paused `ask` tools render an inline
 * decision prompt: y/n for plain tools, a text-answer line for ask_user
 * (approve-with-payload — the answer IS the tool result). Ctrl-C interrupts
 * the running segment; idle Ctrl-C exits.
 */
export function App({ serverUrl, cwd }: TuiProps) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [turn, setTurn] = useState<TurnView>(emptyTurn());
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingMode, setPendingMode] = useState<PendingMode>(null);
  const abortRef = useRef<AbortController | null>(null);

  const turnRef = useRef<TurnView>(emptyTurn());
  const sessionRef = useRef<string | null>(null);
  const messageIdRef = useRef<string>('');
  const modeRef = useRef<'base' | 'standard' | undefined>(undefined);
  const pendingModeRef = useRef<PendingMode>(null);
  pendingModeRef.current = pendingMode;
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const bump = () => setTurn({ ...turnRef.current });

  const note = (text: string) => setHistory((h) => [...h, { role: 'note', text }]);

  // Register the launch cwd as a workspace (manifest, ADR-0013) — best effort.
  useEffect(() => {
    void fetch(`${serverUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: cwd }),
    }).catch(() => {});
  }, [serverUrl, cwd]);

  /** Read a streamed response, fold parts into the LIVE turn view. */
  async function readStream(res: Response) {
    if (!res.body) throw new Error(`HTTP ${res.status}`);
    const decoder = new StreamLineDecoder();
    const reader = res.body.getReader();
    const td = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parts = decoder.push(td.decode(value, { stream: true }));
      if (parts.length) {
        foldParts(turnRef.current, parts);
        if (turnRef.current.sessionId) sessionRef.current = turnRef.current.sessionId;
        bump();
      }
    }
    if (decoder.remainder) {
      const parts = decoder.push('\n');
      foldParts(turnRef.current, parts);
      bump();
    }
  }

  /** Flush a completed turn into the message history. */
  function flushTurn(t: TurnView) {
    const items: HistoryItem[] = [];
    if (t.error) items.push({ role: 'note', text: `⚠ ${t.error}` });
    if (t.text) items.push({ role: 'assistant', text: t.text });
    for (const tc of t.toolCalls) {
      items.push({
        role: 'note',
        text: tc.result !== undefined
          ? `[${tc.toolName}] → ${tc.result.slice(0, 200)}`
          : `[${tc.toolName}] ${JSON.stringify(tc.args)}`,
      });
    }
    if (items.length) setHistory((h) => [...h, ...items]);
  }

  async function runStream(buildFetch: (ctrl: AbortController) => Promise<Response>) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);
    try {
      const res = await buildFetch(ctrl);
      await readStream(res);
    } catch (e: any) {
      if (ctrl.signal.aborted) {
        turnRef.current.text += (turnRef.current.text ? '\n' : '') + '[已中断]';
      } else {
        turnRef.current.error = e?.message ?? String(e);
      }
      bump();
    } finally {
      setStreaming(false);
      abortRef.current = null;
      const t = turnRef.current;
      if (t.pending) {
        setPendingMode(t.pending.expectsAnswer ? 'answer' : 'yesno');
      } else {
        flushTurn(t);
        turnRef.current = emptyTurn();
        bump();
        setPendingMode(null);
      }
    }
  }

  function sendChat(text: string) {
    const messageId = genMessageId();
    messageIdRef.current = messageId;
    turnRef.current = emptyTurn();
    sessionRef.current = null;
    bump();
    setHistory((h) => [...h, { role: 'user', text }]);
    const mode = modeRef.current;
    // The mode rides ONLY the new-session request (ADR-0015: chosen once).
    void runStream((ctrl) =>
      fetch(`${serverUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: cwd, messageId, message: text, mode }),
        signal: ctrl.signal,
      }),
    );
  }

  function sendDecision(decision: 'approve' | 'deny', answer?: string) {
    const pending = turnRef.current.pending;
    const sessionId = sessionRef.current;
    if (!pending || !sessionId) {
      setPendingMode(null);
      return;
    }
    setPendingMode(null);
    void runStream((ctrl) =>
      fetch(`${serverUrl}/api/chat/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace: cwd,
          sessionId,
          messageId: messageIdRef.current,
          toolCallId: pending.toolCallId,
          decision,
          answer,
        }),
        signal: ctrl.signal,
      }),
    );
  }

  async function runCommand(cmd: TuiCommand) {
    switch (cmd.type) {
      case 'new': {
        sessionRef.current = null;
        modeRef.current = cmd.mode;
        setHistory([]);
        note(`新会话（mode: ${cmd.mode ?? 'standard'}）`);
        break;
      }
      case 'resume': {
        const res = await fetch(`${serverUrl}/api/session?workspace=${encodeURIComponent(cwd)}&session=${encodeURIComponent(cmd.id)}`);
        if (!res.ok) {
          note(`恢复失败：HTTP ${res.status}`);
          break;
        }
        const data = (await res.json()) as { messages: any[]; title?: string };
        const items: HistoryItem[] = [];
        for (const m of data.messages) {
          if (m.role === 'system') continue;
          if (m.role === 'user') items.push({ role: 'user', text: String(m.content ?? '') });
          else if (m.role === 'assistant') {
            const parts = Array.isArray(m.content) ? m.content : [];
            const text = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
            if (text) items.push({ role: 'assistant', text });
            for (const tc of parts.filter((p: any) => p.type === 'tool-call')) {
              items.push({ role: 'note', text: `[${tc.toolName}] ${JSON.stringify(tc.args ?? {})}` });
            }
          } else if (m.role === 'tool') {
            const parts = Array.isArray(m.content) ? m.content : [];
            for (const p of parts) {
              if (p.type === 'tool-result') items.push({ role: 'note', text: `→ ${String(p.result).slice(0, 200)}` });
            }
          }
        }
        setHistory(items);
        sessionRef.current = cmd.id;
        messageIdRef.current = genMessageId();
        note(data.title ? `已恢复会话 ${cmd.id}（${data.title}）` : `已恢复会话 ${cmd.id}`);
        break;
      }
      case 'sessions': {
        const res = await fetch(`${serverUrl}/api/workspaces`);
        if (!res.ok) {
          note(`获取会话列表失败：HTTP ${res.status}`);
          break;
        }
        const { workspaces } = (await res.json()) as { workspaces: any[] };
        const ws = workspaces.find((w) => w.path === cwd) ?? workspaces.find((w) => w.slug === cwd);
        if (!ws || !ws.sessions?.length) {
          note(`当前工作区（${cwd}）暂无会话。/new 开始一个新会话。`);
          break;
        }
        for (const s of ws.sessions) {
          note(`${s.id}  ${s.title}${s.pinned ? ' 📌' : ''}`);
        }
        break;
      }
      case 'config': {
        const res = await fetch(`${serverUrl}/api/config`);
        const body = (await res.json()) as { provider?: string; model?: string; reasoningLevel?: string };
        note(
          body.provider && body.model
            ? `model: ${body.provider} / ${body.model}${body.reasoningLevel ? `（推理 ${body.reasoningLevel}）` : ''}`
            : '未配置模型（请先设置提供方与密钥）',
        );
        break;
      }
      case 'level': {
        const sessionId = sessionRef.current;
        if (!sessionId) {
          note('/level 需要先有会话');
          break;
        }
        const res = await fetch(`${serverUrl}/api/session`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: cwd, sessionId, action: 'level', level: cmd.level }),
        });
        note(res.ok ? `已切换权限级别：${cmd.level}` : `切换失败：HTTP ${res.status}`);
        break;
      }
      case 'help':
        note('命令：/new [base|standard] 新会话 /resume <id> 恢复 /sessions 列表 /config 模型 /level <level> 权限 /exit 退出');
        break;
      case 'exit':
        process.exit(0);
        break;
      case 'error':
        note(cmd.message);
        break;
    }
  }

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === 'c') {
      if (streamingRef.current && abortRef.current) {
        abortRef.current.abort();
      } else if (pendingModeRef.current) {
        // A pending decision can be cancelled: deny the current ask.
        setPendingMode(null);
        sendDecision('deny');
      } else {
        process.exit(0);
      }
      return;
    }

    const mode = pendingModeRef.current;
    if (mode === 'yesno') {
      if (inputStr === 'y') sendDecision('approve');
      else if (inputStr === 'n') sendDecision('deny');
      return;
    }
    if (mode === 'answer') {
      if (key.return) {
        const text = input.trim();
        setInput('');
        sendDecision(text ? 'approve' : 'deny', text || undefined);
      } else if (key.backspace || key.delete) {
        setInput((i) => i.slice(0, -1));
      } else if (inputStr && !key.ctrl && !key.meta) {
        setInput((i) => i + inputStr);
      }
      return;
    }

    if (key.return && !key.shift) {
      const text = input.trim();
      if (text && !streamingRef.current) {
        setInput('');
        const cmd = parseCommand(text);
        if (cmd) {
          void runCommand(cmd);
        } else {
          void sendChat(text);
        }
      }
      return;
    }
    if (key.return && key.shift) {
      setInput((i) => i + '\n');
      return;
    }
    if (key.backspace || key.delete) {
      setInput((i) => i.slice(0, -1));
      return;
    }
    if (inputStr && !key.ctrl && !key.meta) {
      setInput((i) => i + inputStr);
    }
  });

  const assistantVisible = streaming || turn.text || turn.toolCalls.length > 0 || turn.error || turn.pending;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" paddingX={1}>
        <Text bold color="green">applepi</Text>
        <Text dimColor> — {cwd} @ {serverUrl}</Text>
      </Box>

      {history.map((m, i) => (
        <Box key={i} marginTop={m.role === 'user' ? 1 : 0}>
          {m.role === 'user' ? (
            <Text color="cyan">&gt; {m.text}</Text>
          ) : m.role === 'note' ? (
            <Text dimColor>{m.text}</Text>
          ) : (
            <Text>{m.text}</Text>
          )}
        </Box>
      ))}

      {assistantVisible && (
        <Box flexDirection="column" marginTop={1}>
          {turn.text ? <Text>{turn.text}</Text> : null}
          {turn.toolCalls.map((tc) => (
            <Box key={tc.toolCallId} flexDirection="column" marginTop={1}>
              <Text color="magenta">[tool] {tc.toolName}</Text>
              <Text dimColor>{JSON.stringify(tc.args)}</Text>
              {tc.result !== undefined ? <Text dimColor>→ {tc.result}</Text> : null}
            </Box>
          ))}
          {turn.error ? <Text color="red">⚠ {turn.error}</Text> : null}
          {turn.pending && !streaming ? (
            <Box marginTop={1}>
              {pendingMode === 'answer' ? (
                <Text color="yellow">回答 {turn.pending.toolName}（回车提交；空回车拒绝）：</Text>
              ) : (
                <Text color="yellow">批准 {turn.pending.toolName}？[y/n]</Text>
              )}
            </Box>
          ) : null}
          {streaming ? <Text color="yellow">▍</Text> : null}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="green">&gt; </Text>
        <Text>{input}</Text>
      </Box>
      <Text dimColor>
        {streaming
          ? 'Ctrl-C 中断'
          : pendingMode === 'yesno'
            ? '[y] 批准 / [n] 拒绝 / Ctrl-C 拒绝'
            : pendingMode === 'answer'
              ? '回车提交答案 / 空回车拒绝 / Ctrl-C 拒绝'
              : 'Enter 发送 / Shift+Enter 换行 / Ctrl-C 退出'}
      </Text>
    </Box>
  );
}