import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api';
import { describe, expect, it } from 'vitest';

import { validateAuditSegment } from '../auditConfigBody';

function patch(audit: unknown): Partial<OutboundApiServerConfig> {
  return { audit } as unknown as Partial<OutboundApiServerConfig>;
}

describe('validateAuditSegment', () => {
  it('accepts -1 as the unlimited body-size sentinel', () => {
    expect(validateAuditSegment(patch({ maxBodyBytes: -1 }))).toEqual([]);
    expect(validateAuditSegment(patch({ maxBodyBytes: 0 }))).toEqual([]);
    expect(validateAuditSegment(patch({ maxBodyBytes: 8192 }))).toEqual([]);
  });

  it('rejects body-size limits below -1 and non-numeric values', () => {
    expect(validateAuditSegment(patch({ maxBodyBytes: -2 }))).toEqual([
      'audit.maxBodyBytes must be -1 or a non-negative number',
    ]);
    expect(validateAuditSegment(patch({ maxBodyBytes: 'unlimited' })).length).toBeGreaterThan(0);
  });
});
