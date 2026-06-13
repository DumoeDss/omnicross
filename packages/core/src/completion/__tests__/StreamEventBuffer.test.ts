import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _peekForTests,
  _resetForTests,
  attach,
  emit,
  register,
  release,
  type StreamEvent,
} from '../StreamEventBuffer';

interface FakeWebContents {
  send: (channel: string, payload: unknown) => void;
  isDestroyed: () => boolean;
}

interface SentRecord {
  channel: string;
  payload: StreamEvent;
}

function makeSender(): { sender: FakeWebContents; sent: SentRecord[]; destroy: () => void } {
  let destroyed = false;
  const sent: SentRecord[] = [];
  return {
    sender: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload: payload as StreamEvent });
      },
      isDestroyed: () => destroyed,
    },
    sent,
    destroy: () => {
      destroyed = true;
    },
  };
}

const channel = (id: string) => `completion:stream:${id}`;

describe('StreamEventBuffer', () => {
  beforeEach(() => {
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it('queues events emitted before subscribe and replays them in order on attach', () => {
    const { sender, sent } = makeSender();
    const id = 's1';

    register(id, sender as never);
    emit(id, { type: 'start', messageId: 'm1' });
    emit(id, { type: 'delta', content: 'hello ' });
    emit(id, { type: 'delta', content: 'world' });

    // Nothing sent yet — the client hasn't subscribed.
    expect(sent).toHaveLength(0);
    expect(_peekForTests(id)?.queueLength).toBe(3);
    expect(_peekForTests(id)?.attached).toBe(false);

    const result = attach(id);

    expect(result).toEqual({ ok: true, drained: 3 });
    expect(sent.map((s) => s.payload.type)).toEqual(['start', 'delta', 'delta']);
    expect(sent.every((s) => s.channel === channel(id))).toBe(true);
    expect(_peekForTests(id)?.queueLength).toBe(0);
    expect(_peekForTests(id)?.attached).toBe(true);
  });

  it('forwards directly when subscribe happens before any emit', () => {
    const { sender, sent } = makeSender();
    const id = 's2';

    register(id, sender as never);
    const result = attach(id);

    expect(result).toEqual({ ok: true, drained: 0 });

    emit(id, { type: 'start', messageId: 'm1' });
    emit(id, { type: 'delta', content: 'a' });

    expect(sent).toHaveLength(2);
    expect(sent[0].payload.type).toBe('start');
    expect(_peekForTests(id)?.queueLength).toBe(0);
  });

  it('drains queue partway, then forwards subsequent events directly', () => {
    const { sender, sent } = makeSender();
    const id = 's3';

    register(id, sender as never);
    emit(id, { type: 'start', messageId: 'm1' });
    emit(id, { type: 'delta', content: 'a' });
    emit(id, { type: 'delta', content: 'b' });

    expect(attach(id).drained).toBe(3);

    emit(id, { type: 'delta', content: 'c' });
    emit(id, { type: 'done', message: { content: 'abc' } });

    expect(sent.map((s) => (s.payload as StreamEvent).type)).toEqual([
      'start',
      'delta',
      'delta',
      'delta',
      'done',
    ]);
  });

  it('caps the queue at 200 events and evicts oldest non-terminal first', () => {
    const { sender, sent } = makeSender();
    const id = 's4';

    register(id, sender as never);
    // Fill with 200 deltas: chunk-0 through chunk-199.
    for (let i = 0; i < 200; i++) {
      emit(id, { type: 'delta', content: `chunk-${i}` });
    }
    expect(_peekForTests(id)?.queueLength).toBe(200);

    // Overflow: evict oldest non-terminal (chunk-0), append new tail.
    emit(id, { type: 'delta', content: 'overflow-1' });

    expect(_peekForTests(id)?.queueLength).toBe(200);

    attach(id);
    expect(sent.length).toBe(200);
    const first = sent[0].payload as unknown as { content: string };
    const last = sent[sent.length - 1].payload as unknown as { content: string };
    expect(first.content).toBe('chunk-1'); // chunk-0 was evicted
    expect(last.content).toBe('overflow-1');
  });

  it('keeps terminal events sticky across overflow', () => {
    const { sender, sent } = makeSender();
    const id = 's5';

    register(id, sender as never);
    emit(id, { type: 'error', error: 'first error' });
    for (let i = 0; i < 250; i++) {
      emit(id, { type: 'delta', content: `c-${i}` });
    }

    attach(id);
    const types = sent.map((s) => (s.payload as StreamEvent).type);
    // The error must survive even though we emitted 250 deltas after it.
    expect(types).toContain('error');
  });

  it('preserves done event when emitted before subscribe and releases on next tick', async () => {
    const { sender, sent } = makeSender();
    const id = 's6';

    register(id, sender as never);
    emit(id, { type: 'start', messageId: 'm1' });
    emit(id, { type: 'delta', content: 'a' });
    emit(id, { type: 'done', message: { content: 'a' } });

    release(id);

    // Still buffered — release defers when not attached.
    expect(_peekForTests(id)).not.toBeNull();
    expect(_peekForTests(id)?.queueLength).toBe(3);

    // Late subscribe within the same tick still drains.
    const result = attach(id);
    expect(result.drained).toBe(3);
    expect(sent.map((s) => (s.payload as StreamEvent).type)).toEqual([
      'start',
      'delta',
      'done',
    ]);

    // After the deferred tick, entry is gone.
    await new Promise((r) => { setImmediate(r); });
    expect(_peekForTests(id)).toBeNull();
  });

  it('drops the buffer when WebContents is destroyed mid-stream', () => {
    const { sender, sent, destroy } = makeSender();
    const id = 's7';

    register(id, sender as never);
    emit(id, { type: 'start', messageId: 'm1' });
    destroy();
    emit(id, { type: 'delta', content: 'too late' });

    expect(_peekForTests(id)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('attach is idempotent', () => {
    const { sender, sent } = makeSender();
    const id = 's8';

    register(id, sender as never);
    emit(id, { type: 'start', messageId: 'm1' });

    expect(attach(id).drained).toBe(1);
    expect(attach(id).drained).toBe(0);

    emit(id, { type: 'delta', content: 'a' });
    expect(sent).toHaveLength(2);
  });

  it('emit on unknown streamId is a no-op', () => {
    const { sender, sent } = makeSender();
    void sender;
    emit('does-not-exist', { type: 'delta', content: 'x' });
    expect(sent).toHaveLength(0);
  });

  it('release on already-attached stream cleans up immediately', async () => {
    const { sender } = makeSender();
    const id = 's9';

    register(id, sender as never);
    attach(id);
    release(id);

    expect(_peekForTests(id)).toBeNull();
  });

  it('a second register replaces the prior entry (engine retry)', () => {
    const a = makeSender();
    const b = makeSender();
    const id = 's10';

    register(id, a.sender as never);
    emit(id, { type: 'delta', content: 'first' });
    register(id, b.sender as never); // new attempt
    emit(id, { type: 'delta', content: 'second' });

    attach(id);
    // Only 'second' should arrive — re-registration cleared the old queue.
    expect(b.sent.map((s) => (s.payload as unknown as { content: string }).content)).toEqual(['second']);
    expect(a.sent).toHaveLength(0);
  });

  it('dispatches every event to the originally-registered sender, not other tabs', () => {
    const a = makeSender();
    const b = makeSender();

    register('a-stream', a.sender as never);
    register('b-stream', b.sender as never);

    emit('a-stream', { type: 'delta', content: 'for-a' });
    emit('b-stream', { type: 'delta', content: 'for-b' });

    attach('a-stream');
    attach('b-stream');

    expect(a.sent.map((s) => (s.payload as unknown as { content: string }).content)).toEqual(['for-a']);
    expect(b.sent.map((s) => (s.payload as unknown as { content: string }).content)).toEqual(['for-b']);
  });

  it('returns ok=false from attach when streamId never registered', () => {
    expect(attach('phantom')).toEqual({ ok: false, drained: 0 });
  });

  it('does not throw when sender.send fails (e.g. ipc closed)', () => {
    const failingSender: FakeWebContents = {
      send: vi.fn(() => {
        throw new Error('ipc closed');
      }),
      isDestroyed: () => false,
    };
    register('s-fail', failingSender as never);
    emit('s-fail', { type: 'delta', content: 'x' });
    expect(() => attach('s-fail')).not.toThrow();
  });
});
