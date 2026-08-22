import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { StreamLineDecoder } from './stream-parser.js';
import { emptyTurn, foldParts, genMessageId, type TurnView } from './utils.js';

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
  const pendingModeRef = useRef<PendingMode>(null);
  pendingModeRef.current = pendingMode;
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const bump = () => setTurn({ ...turnRef.current });

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

  function sendChat(text: string, mode?: string) {
    const messageId = genMessageId();
    messageIdRef.current = messageId;
    turnRef.current = emptyTurn();
    sessionRef.current = null;
    bump();
    setHistory((h) => [...h, { role: 'user', text }]);
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
        void sendChat(text);
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