/**
 * StreamEventBuffer — per-streamId event queue for streamed completion delivery.
 *
 * Closes the subscribe-vs-emit race between a producer that starts the LLM call
 * asynchronously and a consumer that only attaches its listener after awaiting a
 * reply. Events emitted before `attach(streamId)` is called are queued and
 * replayed in order on attach.
 */

/**
 * Minimal structural sender — the subset of an Electron `WebContents` (or any
 * IPC channel) this buffer actually uses. Kept LOCAL so core has zero electron
 * dependency; the host passes any object satisfying this shape.
 */
export interface StreamSender {
  isDestroyed(): boolean;
  send(channel: string, payload: StreamEvent): void;
}

export type StreamEventType =
  | 'start'
  | 'delta'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'tool_use'
  | 'block'
  | 'search_start'
  | 'search_result'
  | 'done'
  | 'error'
  | 'abort';

export interface StreamEvent {
  type: StreamEventType;
  [key: string]: unknown;
}

interface BufferEntry {
  sender: StreamSender;
  queue: StreamEvent[];
  attached: boolean;
  closed: boolean;
}

const TERMINAL_TYPES: ReadonlySet<StreamEventType> = new Set(['done', 'error', 'abort']);

const QUEUE_CAP = 200;

const entries = new Map<string, BufferEntry>();

function channelOf(streamId: string): string {
  return `completion:stream:${streamId}`;
}

function safeIsDestroyed(sender: StreamSender): boolean {
  try {
    return sender.isDestroyed();
  } catch {
    return true;
  }
}

function safeSend(sender: StreamSender, channel: string, payload: StreamEvent): boolean {
  if (safeIsDestroyed(sender)) return false;
  try {
    sender.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register a new stream. Called by the engine / handler immediately after the
 * `streamId` is created, before any `emit`. Idempotent re-registration replaces
 * the sender (covers the rare case of the engine retrying with the same id).
 */
export function register(streamId: string, sender: StreamSender): void {
  entries.set(streamId, { sender, queue: [], attached: false, closed: false });
}

/**
 * Emit an event for `streamId`. Forwards directly if the client has attached;
 * otherwise queues until `attach` is called. Bounded at QUEUE_CAP — overflow
 * evicts the oldest non-terminal event.
 */
export function emit(streamId: string, event: StreamEvent): void {
  const entry = entries.get(streamId);
  if (!entry) {
    // No registration — likely a late callback after `release`. Drop silently.
    return;
  }
  if (safeIsDestroyed(entry.sender)) {
    entries.delete(streamId);
    return;
  }
  if (entry.attached) {
    safeSend(entry.sender, channelOf(streamId), event);
    return;
  }

  if (entry.queue.length >= QUEUE_CAP) {
    const evictAt = entry.queue.findIndex((e) => !TERMINAL_TYPES.has(e.type));
    if (evictAt >= 0) {
      entry.queue.splice(evictAt, 1);
    } else {
      // Queue is entirely terminal events — exotic; drop the oldest anyway.
      entry.queue.shift();
    }
  }
  entry.queue.push(event);
}

/**
 * The client announced readiness via the `completion:stream:subscribe` IPC. Drains
 * the queue synchronously to the bound sender, then flips to direct-forward mode.
 * Returns the number of events drained for diagnostic purposes.
 */
export function attach(streamId: string): { ok: boolean; drained: number } {
  const entry = entries.get(streamId);
  if (!entry) return { ok: false, drained: 0 };
  if (entry.attached) return { ok: true, drained: 0 };

  const channel = channelOf(streamId);
  let drained = 0;
  for (const event of entry.queue) {
    if (safeSend(entry.sender, channel, event)) {
      drained++;
    }
  }
  entry.queue = [];
  entry.attached = true;
  return { ok: true, drained };
}

/**
 * Mark a stream finished. If the client has already attached, release
 * synchronously. Otherwise defer one tick so a late `subscribe` arriving on the
 * heels of the `done`/`error` event still drains the queue before cleanup.
 */
export function release(streamId: string): void {
  const entry = entries.get(streamId);
  if (!entry) return;
  if (entry.closed) return;
  entry.closed = true;

  if (entry.attached) {
    entries.delete(streamId);
    return;
  }
  setImmediate(() => {
    entries.delete(streamId);
  });
}

/** Test-only: reset internal state. Not exported from the index. */
export function _resetForTests(): void {
  entries.clear();
}

/** Test-only: inspect internal state. Not exported from the index. */
export function _peekForTests(streamId: string): {
  queueLength: number;
  attached: boolean;
  closed: boolean;
} | null {
  const entry = entries.get(streamId);
  if (!entry) return null;
  return {
    queueLength: entry.queue.length,
    attached: entry.attached,
    closed: entry.closed,
  };
}
