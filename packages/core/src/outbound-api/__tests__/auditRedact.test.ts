import { describe, expect, it } from 'vitest';

import { AUDIT_REDACTED, redactAuditText } from '../auditRedact';

/** No known secret prefix survives the redaction pass. */
function scanForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const re of [
    /\bsk-[A-Za-z0-9_-]{6,}/,
    /\bAIza[A-Za-z0-9_-]{10,}/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  ]) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

describe('redactAuditText', () => {
  it('masks an sk- API key (OpenAI / omnicross / anthropic families)', () => {
    for (const key of ['sk-abcd1234efgh', 'sk-ant-api03-XYZ12345', 'sk-omnicross-abcdef123456', 'sk-proj-AAaa11bb22']) {
      const out = redactAuditText(`my key is ${key} ok`);
      expect(out).toContain(AUDIT_REDACTED);
      expect(scanForSecrets(out)).toEqual([]);
    }
  });

  it('masks a Bearer token (bare, no label)', () => {
    const out = redactAuditText('token is Bearer sometoken-abc123XYZ here');
    expect(out).toContain(`Bearer ${AUDIT_REDACTED}`);
    expect(out).not.toContain('sometoken-abc123XYZ');
    expect(scanForSecrets(out)).toEqual([]);
  });

  it('masks a labelled Authorization: Bearer value', () => {
    const out = redactAuditText('Authorization: Bearer sometoken-abc123XYZ');
    expect(out).not.toContain('sometoken-abc123XYZ');
    expect(scanForSecrets(out)).toEqual([]);
  });

  it('masks an x-api-key / api-key inline value', () => {
    expect(redactAuditText('"x-api-key": "sk-omnicross-secret999"')).not.toContain('sk-omnicross-secret999');
    expect(redactAuditText('api_key=AKIAsupersecretvalue123')).not.toContain('AKIAsupersecretvalue123');
  });

  it('masks a Google AIza key', () => {
    const out = redactAuditText('key AIzaSyD-abcdefghij1234567890XYZ used');
    expect(out).toContain(AUDIT_REDACTED);
    expect(scanForSecrets(out)).toEqual([]);
  });

  it('leaves clean text unchanged', () => {
    const clean = 'Please summarize the following document about cats.';
    expect(redactAuditText(clean)).toBe(clean);
  });

  it('never throws on empty / odd input', () => {
    expect(redactAuditText('')).toBe('');
  });
});
