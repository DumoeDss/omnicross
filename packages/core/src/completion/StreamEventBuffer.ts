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
  terminal?: boolean;
  cancelCleanup?: () => void;
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
  entries.get(streamId)?.cancelCleanup?.();
  entries.set(streamId, { sender, queue: [], attached: false, closed: false });
}

/**
 * Emit an event for `streamId`. Forwards directly if the client has attached;
 * otherwise queues until `attach` is called. Overflow coalesces adjacent text
 * deltas or reports an explicit error instead of silently losing output.
 */
export function emit(streamId: string, event: StreamEvent): void {
  const entry = entries.get(streamId);
  if (!entry) {
    // No registration — likely a late callback after `release`. Drop silently.
    return;
  }
  if (safeIsDestroyed(entry.sender)) {
    entry.cancelCleanup?.();
    entries.delete(streamId);
    return;
  }
  if (entry.terminal) return;
  if (TERMINAL_TYPES.has(event.type)) entry.terminal = true;
  if (entry.attached) {
    safeSend(entry.sender, channelOf(streamId), event);
    return;
  }

  if (entry.terminal) {
    entry.queue.push(event);
    return;
  }
  if (entry.queue.length >= QUEUE_CAP) {
    const last = entry.queue[entry.queue.length - 1];
    if ((event.type === 'delta' || event.type === 'reasoning') && last.type === event.type
      && typeof event.content === 'string' && typeof last.content === 'string'
      && Object.keys(event).length === 2 && Object.keys(last).length === 2) {
      entry.queue[entry.queue.length - 1] = { ...last, content: last.content + event.content };
      return;
    }
    entry.queue.push({ type: 'error', error: 'Stream event buffer overflow before subscription' });
    entry.terminal = true;
    return;
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
  if (entry.closed) {
    entry.cancelCleanup?.();
    entries.delete(streamId);
  }
  return { ok: true, drained };
}

/**
 * Mark a stream finished. Attached streams are released synchronously.
 * Otherwise retain completed events for a bounded subscription
 * grace period, including subscriptions that arrive on a later event-loop tick.
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
  const timer = setTimeout(() => {
    if (entries.get(streamId) === entry) entries.delete(streamId);
  }, 30_000);
  timer.unref();
  entry.cancelCleanup = () => clearTimeout(timer);
}

/** Test-only: reset internal state. Not exported from the index. */
export function _resetForTests(): void {
  for (const entry of entries.values()) entry.cancelCleanup?.();
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
