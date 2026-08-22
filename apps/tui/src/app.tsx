import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { StreamLineDecoder } from './stream-parser.js';
import { emptyTurn, foldParts, genMessageId, type TurnView } from './utils.js';

export interface TuiProps {
  serverUrl: string;
  cwd: string;
}

interface HistoryItem {
  role: 'user' | 'assistant' | 'tool-note';
  text: string;
}

/**
 * The Claude Code-style core session loop (ADR-0017 ticket 06): bottom input
 * (Enter sends, Shift+Enter newline), streamed assistant text rendered inline,
 * tool calls as compact cards, Ctrl-C aborts the running segment (fetch abort
 * → the server stops it). Tool APPROVAL (y/n) and ask_user answers arrive in
 * ticket 07; until then a paused turn renders a "等待批准" note.
 */
export function App({ serverUrl, cwd }: TuiProps) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [turn, setTurn] = useState<TurnView>(emptyTurn());
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const turnRef = useRef<TurnView>(emptyTurn());
  const historyRef = useRef(history);
  const sessionRef = useRef<string | null>(null);
  historyRef.current = history;
  const bump = () => setTurn({ ...turnRef.current });

  // Register the launch cwd as a workspace (manifest, ADR-0013) — best effort.
  useEffect(() => {
    void fetch(`${serverUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: cwd }),
    }).catch(() => {});
  }, [serverUrl, cwd]);

  async function send(text: string) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setHistory((h) => [...h, { role: 'user', text }]);
    turnRef.current = emptyTurn();
    sessionRef.current = null;
    bump();
    setStreaming(true);
    try {
      const res = await fetch(`${serverUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: cwd, messageId: genMessageId(), message: text }),
        signal: ctrl.signal,
      });
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
      if (t.text || t.error) {
        setHistory((h) => [...h, { role: 'assistant', text: t.error ? `⚠ ${t.error}` : t.text }]);
      }
      const pendingTool = t.pending?.toolName;
      if (pendingTool) {
        setHistory((h) => [...h, { role: 'tool-note', text: `⏸ 等待批准：${pendingTool}（票 07 起支持操作）` }]);
      }
      turnRef.current = emptyTurn();
      bump();
    }
  }

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === 'c') {
      if (streaming && abortRef.current) {
        abortRef.current.abort();
      } else {
        process.exit(0);
      }
      return;
    }
    if (key.return && !key.shift) {
      const text = input.trim();
      if (text && !streaming) {
        setInput('');
        void send(text);
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
          ) : m.role === 'tool-note' ? (
            <Text color="yellow">{m.text}</Text>
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
          {turn.pending ? (
            <Text color="yellow">⏸ 等待批准：{turn.pending.toolName}</Text>
          ) : null}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="green">&gt; </Text>
        <Text>{input}</Text>
        {streaming ? <Text color="yellow">▍</Text> : null}
      </Box>
      <Text dimColor>
        {streaming ? 'Ctrl-C 中断' : 'Enter 发送 / Shift+Enter 换行 / Ctrl-C 退出'}
      </Text>
    </Box>
  );
}