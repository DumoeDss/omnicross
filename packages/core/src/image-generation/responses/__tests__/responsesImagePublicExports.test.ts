import { describe, expect, it } from 'vitest';

import {
  createResponsesImageGenerationContribution,
  InMemoryResponsesImageStateStore,
  type ResponsesImageEventAllocator,
  type ResponsesImageGenerationContribution,
  type ResponsesImageRequestScope,
} from '../../../index';

describe('@omnicross/core Responses image public exports', () => {
  it('exports the narrow dormant factory/state/allocator/request-scope seam', () => {
    expect(typeof createResponsesImageGenerationContribution).toBe('function');
    expect(new InMemoryResponsesImageStateStore()).toBeInstanceOf(InMemoryResponsesImageStateStore);
    const allocator: ResponsesImageEventAllocator = {
      reserveOutputIndex: () => 2,
      nextSequenceNumber: () => 7,
    };
    const contribution = undefined as unknown as ResponsesImageGenerationContribution;
    const scope = undefined as unknown as ResponsesImageRequestScope;
    expect(allocator.reserveOutputIndex()).toBe(2);
    expect(contribution).toBeUndefined();
    expect(scope).toBeUndefined();
  });

});
