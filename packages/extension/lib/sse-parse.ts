/**
 * Incremental Server-Sent Events parser — a pure module (no extension/DOM APIs),
 * so it can be imported by the MAIN-world injected hook AND the background gateway.
 *
 * Parses the text/event-stream grammar: lines accumulate into a frame; a blank line
 * dispatches it. `data:` lines join with "\n"; `event:` / `id:` set those fields;
 * lines starting ":" are comments (heartbeats) and ignored. CRLF is tolerated.
 *
 * Usage:
 *   const p = createSseParser();
 *   for (const chunk of chunks) for (const ev of p.push(chunk)) handle(ev);
 *   for (const ev of p.flush()) handle(ev); // trailing frame not terminated by \n\n
 */

/** One parsed Server-Sent Event. */
export interface SseEvent {
  /** The event's `event:` field, if any (defaults to "message" per the SSE spec). */
  event?: string;
  /** The event's `id:` field, if any. */
  id?: string;
  /** The joined `data:` lines for this event. */
  data: string;
}

export interface SseParser {
  /** Feed a text chunk; returns any events completed by it. */
  push(chunk: string): SseEvent[];
  /** Flush a trailing frame not terminated by a blank line. Returns 0 or 1 event. */
  flush(): SseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let evName: string | undefined;
  let evId: string | undefined;

  const takeFrame = (): SseEvent | null => {
    if (dataLines.length === 0 && evName === undefined && evId === undefined) {
      return null;
    }
    const ev: SseEvent = {
      ...(evName !== undefined ? { event: evName } : {}),
      ...(evId !== undefined ? { id: evId } : {}),
      data: dataLines.join('\n'),
    };
    dataLines = [];
    evName = undefined;
    evId = undefined;
    return ev;
  };

  const handleLine = (rawLine: string): SseEvent | null => {
    // Trailing CR from a CRLF split.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return takeFrame(); // blank line dispatches the frame
    if (line.startsWith(':')) return null; // comment / heartbeat
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') evName = value;
    else if (field === 'id') evId = value;
    // `retry` and unknown fields are ignored.
    return null;
  };

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const out: SseEvent[] = [];
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const ev = handleLine(line);
        if (ev) out.push(ev);
      }
      return out;
    },
    flush(): SseEvent[] {
      const out: SseEvent[] = [];
      // Any leftover partial line (no trailing newline) is a final line.
      if (buffer.length > 0) {
        const ev = handleLine(buffer);
        buffer = '';
        if (ev) out.push(ev);
      }
      const trailing = takeFrame();
      if (trailing) out.push(trailing);
      return out;
    },
  };
}
