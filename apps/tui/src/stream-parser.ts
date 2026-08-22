/**
 * Pure decoder for the AI SDK v4 data-stream wire format (ADR-0017 R2Q1: the
 * wire protocol is unchanged; the TUI implements its own parser of the same
 * format the web client parses).
 *
 * Line grammar: `<prefix>:<JSON>` per line. Prefixes seen here:
 *   `0:` text part (JSON string)     `3:` error part (JSON string)
 *   `2:` data parts (JSON array)     `d:` finish part (JSON object)
 *   `9:` tool-call part (JSON obj)   `a:` tool-result part (JSON obj)
 * Anything else is tolerated and surfaced as `unknown` (forward compatible).
 *
 * The decoder buffers partial lines across chunks — a streamed response may
 * cut a line mid-flight.
 */
export const STREAM_PREFIXES = new Set(['0', '2', '3', '9', 'a', 'd']);

export type ParsedStreamPart =
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'data'; values: any[] }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: any }
  | { type: 'tool-result'; toolCallId: string; result: string }
  | { type: 'finish'; value: any }
  | { type: 'unknown'; prefix: string; raw: string };

export class StreamLineDecoder {
  private buffer = '';

  /** Feed a chunk of raw stream text; returns every COMPLETE line parsed. */
  push(chunk: string): ParsedStreamPart[] {
    this.buffer += chunk;
    const parts: ParsedStreamPart[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const parsed = StreamLineDecoder.parseLine(line);
      if (parsed) parts.push(parsed);
    }
    return parts;
  }

  /** Any trailing partial line still buffered. */
  get remainder(): string {
    return this.buffer;
  }

  static parseLine(line: string): ParsedStreamPart | null {
    const colon = line.indexOf(':');
    if (colon === -1) return { type: 'unknown', prefix: '', raw: line };
    const prefix = line.slice(0, colon);
    const raw = line.slice(colon + 1);
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return { type: 'unknown', prefix, raw: line };
    }
    switch (prefix) {
      case '0':
        return { type: 'text', text: String(json) };
      case '3':
        return { type: 'error', message: String(json) };
      case '2':
        return { type: 'data', values: Array.isArray(json) ? json : [json] };
      case '9':
        return {
          type: 'tool-call',
          toolCallId: String(json.toolCallId),
          toolName: String(json.toolName),
          args: json.args ?? {},
        };
      case 'a':
        return { type: 'tool-result', toolCallId: String(json.toolCallId), result: String(json.result) };
      case 'd':
        return { type: 'finish', value: json };
      default:
        return { type: 'unknown', prefix, raw: line };
    }
  }
}