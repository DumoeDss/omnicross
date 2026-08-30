import { describe, expect, it } from 'vitest';

import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';

import {
  InMemoryResponsesImageStateStore,
  type ResponsesImageStateCommitInput,
} from '../ResponsesImageStateStore';
import type { ResponsesImageCallBinding, ResponsesImageCallId } from '../types';

const call = (suffix: string) => `ig_${suffix.padEnd(16, suffix)}` as ResponsesImageCallId;
const reference = (value: string) => value as ImageReferenceId;
const binding = (id: ResponsesImageCallId, ref: string, expiresAt = 200): ResponsesImageCallBinding => ({
  callId: id,
  referenceId: reference(ref),
  expiresAt,
});

function commitInput(
  responseId: string,
  bindings: readonly ResponsesImageCallBinding[],
  tenantId = 'tenant-a',
  responseExpiresAt = 200,
): ResponsesImageStateCommitInput {
  return { tenantId, responseId, bindings, responseExpiresAt };
}

describe('InMemoryResponsesImageStateStore', () => {
  it('atomically commits multiple calls and resolves direct and response order with idempotent leases', async () => {
    let now = 100;
    const store = new InMemoryResponsesImageStateStore({ now: () => now });
    const first = binding(call('a'), 'ref-a');
    const second = binding(call('b'), 'ref-b');
    await expect(store.commit(commitInput('resp_one', [second, first]))).resolves.toEqual([]);
    await expect(store.commit(commitInput('resp_one', [second, first]))).resolves.toEqual([]);

    const response = await store.resolveResponse('tenant-a', 'resp_one');
    expect(response.status).toBe('found');
    if (response.status !== 'found') return;
    expect(response.lease.callIds).toEqual([second.callId, first.callId]);
    await response.lease.release();
    await response.lease.release();

    const direct = await store.resolveCall('tenant-a', second.callId);
    expect(direct.status).toBe('found');
    if (direct.status === 'found') {
      expect(direct.lease.binding).toEqual(second);
      await direct.lease.release();
      await direct.lease.release();
    }
    now = 101;
    await expect(store.commit(commitInput('resp_one', [first, second])))
      .rejects.toMatchObject({ code: 'image_generation_failed' });
  });

  it('hides cross-tenant state, distinguishes owner expiry, and expires bounded tombstones', async () => {
    let now = 100;
    const store = new InMemoryResponsesImageStateStore({
      now: () => now,
      tombstoneTtlMs: 10,
      maxTombstones: 2,
    });
    const item = binding(call('c'), 'ref-c', 105);
    await store.commit(commitInput('resp_expiring', [item], 'tenant-a', 105));
    expect(await store.resolveCall('tenant-b', item.callId)).toEqual({ status: 'not_found' });
    expect(await store.resolveResponse('tenant-b', 'resp_expiring')).toEqual({ status: 'not_found' });
    now = 106;
    expect(await store.resolveCall('tenant-a', item.callId)).toEqual({ status: 'expired' });
    expect(await store.resolveResponse('tenant-a', 'resp_expiring')).toEqual({ status: 'expired' });
    expect(await store.resolveCall('tenant-b', item.callId)).toEqual({ status: 'not_found' });
    await store.cleanup();
    expect(await store.resolveCall('tenant-a', item.callId)).toEqual({ status: 'expired' });
    now = 117;
    expect(await store.resolveCall('tenant-a', item.callId)).toEqual({ status: 'not_found' });
  });

  it('bounds owner-only tombstones by capacity', async () => {
    let now = 100;
    const store = new InMemoryResponsesImageStateStore({
      now: () => now,
      tombstoneTtlMs: 100,
      maxTombstones: 1,
    });
    const first = binding(call('h'), 'ref-h', 101);
    await store.commit(commitInput('resp_h', [first], 'tenant-a', 101));
    now = 102;
    expect(await store.resolveCall('tenant-a', first.callId)).toEqual({ status: 'expired' });
    await store.cleanup();
    const second = binding(call('i'), 'ref-i', 103);
    await store.commit(commitInput('resp_i', [second], 'tenant-a', 103));
    now = 104;
    expect(await store.resolveCall('tenant-a', second.callId)).toEqual({ status: 'expired' });
    expect(await store.resolveCall('tenant-a', first.callId)).toEqual({ status: 'not_found' });
  });

  it('pins active calls and responses through cleanup, then returns removed bindings', async () => {
    let now = 100;
    const store = new InMemoryResponsesImageStateStore({ now: () => now });
    const item = binding(call('d'), 'ref-d', 105);
    await store.commit(commitInput('resp_pin', [item], 'tenant-a', 105));
    const callLease = await store.resolveCall('tenant-a', item.callId);
    const responseLease = await store.resolveResponse('tenant-a', 'resp_pin');
    expect(callLease.status).toBe('found');
    expect(responseLease.status).toBe('found');
    now = 106;
    expect(await store.cleanup()).toEqual([]);
    if (callLease.status === 'found') await callLease.lease.release();
    expect(await store.cleanup()).toEqual([item]);
    if (responseLease.status === 'found') await responseLease.lease.release();
    expect(await store.cleanup()).toEqual([]);
    expect(await store.resolveResponse('tenant-a', 'resp_pin')).toEqual({ status: 'expired' });
  });

  it('uses non-disclosing LRU capacity eviction and supports tenant-scoped deletion', async () => {
    const store = new InMemoryResponsesImageStateStore({ maxCalls: 1, maxResponses: 1, now: () => 100 });
    const first = binding(call('e'), 'ref-e');
    const second = binding(call('f'), 'ref-f');
    await store.commit(commitInput('resp_first', [first]));
    expect(await store.commit(commitInput('resp_second', [second]))).toEqual([first]);
    expect(await store.resolveCall('tenant-a', first.callId)).toEqual({ status: 'not_found' });
    expect(await store.resolveResponse('tenant-a', 'resp_first')).toEqual({ status: 'not_found' });
    expect(await store.deleteCall('tenant-b', second.callId)).toBeUndefined();
    expect(await store.deleteResponse('tenant-b', 'resp_second')).toBe(false);
    expect(await store.deleteCall('tenant-a', second.callId)).toEqual(second);
    expect(await store.deleteResponse('tenant-a', 'resp_second')).toBe(true);
    expect(await store.resolveCall('tenant-a', second.callId)).toEqual({ status: 'not_found' });
  });

  it('persists bounded tenant-scoped known-empty markers with expiry and non-disclosing eviction', async () => {
    let now = 100;
    const store = new InMemoryResponsesImageStateStore({
      maxResponses: 1,
      now: () => now,
      tombstoneTtlMs: 10,
    });
    await store.commit(commitInput('resp_empty_first', [], 'tenant-a', 105));
    const first = await store.resolveResponse('tenant-a', 'resp_empty_first');
    expect(first.status).toBe('found');
    if (first.status === 'found') {
      expect(first.lease.callIds).toEqual([]);
      await first.lease.release();
    }
    expect(await store.resolveResponse('tenant-b', 'resp_empty_first'))
      .toEqual({ status: 'not_found' });

    await store.commit(commitInput('resp_empty_second', [], 'tenant-a', 200));
    expect(await store.resolveResponse('tenant-a', 'resp_empty_first'))
      .toEqual({ status: 'not_found' });
    const second = await store.resolveResponse('tenant-a', 'resp_empty_second');
    expect(second.status).toBe('found');
    if (second.status === 'found') await second.lease.release();

    now = 201;
    expect(await store.resolveResponse('tenant-a', 'resp_empty_second'))
      .toEqual({ status: 'expired' });
    expect(await store.resolveResponse('tenant-b', 'resp_empty_second'))
      .toEqual({ status: 'not_found' });
  });

  it('evicts expired unleased state before live LRU entries', async () => {
    let now = 100;
    const store = new InMemoryResponsesImageStateStore({
      maxCalls: 2,
      maxResponses: 2,
      now: () => now,
    });
    const live = binding(call('j'), 'ref-j', 200);
    const expiring = binding(call('k'), 'ref-k', 105);
    await store.commit(commitInput('resp_live', [live], 'tenant-a', 200));
    await store.commit(commitInput('resp_expired_capacity', [expiring], 'tenant-a', 105));

    now = 106;
    const replacement = binding(call('l'), 'ref-l', 200);
    await expect(store.commit(commitInput('resp_replacement', [replacement], 'tenant-a', 200)))
      .resolves.toEqual([expiring]);

    const liveCall = await store.resolveCall('tenant-a', live.callId);
    expect(liveCall.status).toBe('found');
    if (liveCall.status === 'found') await liveCall.lease.release();
    expect(await store.resolveCall('tenant-a', expiring.callId)).toEqual({ status: 'expired' });
    const liveResponse = await store.resolveResponse('tenant-a', 'resp_live');
    expect(liveResponse.status).toBe('found');
    if (liveResponse.status === 'found') await liveResponse.lease.release();
    expect(await store.resolveResponse('tenant-a', 'resp_expired_capacity'))
      .toEqual({ status: 'expired' });
  });

  it('rejects conflicting call IDs and response writes without partial mutation', async () => {
    const store = new InMemoryResponsesImageStateStore({ now: () => 100 });
    const first = binding(call('g'), 'ref-g');
    await store.commit(commitInput('resp_conflict', [first]));
    const conflicting = { ...first, referenceId: reference('different') };
    await expect(store.commit(commitInput('resp_other', [conflicting])))
      .rejects.toMatchObject({ code: 'image_generation_failed' });
    expect(await store.resolveResponse('tenant-a', 'resp_other')).toEqual({ status: 'not_found' });
    const found = await store.resolveCall('tenant-a', first.callId);
    expect(found.status).toBe('found');
    if (found.status === 'found') await found.lease.release();
  });
});
