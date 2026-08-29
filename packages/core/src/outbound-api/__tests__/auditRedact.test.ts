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

  it('redacts every nested encrypted_content value while retaining compact structure', () => {
    const captured = JSON.stringify({
      object: 'response.compaction',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'visible' }] },
        { type: 'reasoning', encrypted_content: 'reasoning-secret', summary: [] },
        {
          type: 'compaction',
          encrypted_content: { opaque: 'window-secret' },
          nested: [{ encrypted_content: null, safe: 7 }],
        },
      ],
      metadata: { safe: true },
    });

    const redacted = JSON.parse(redactAuditText(captured)) as {
      output: Array<Record<string, unknown>>;
      metadata: { safe: boolean };
    };
    expect(redacted.output).toHaveLength(3);
    expect(redacted.output[0]).toEqual({
      type: 'message',
      content: [{ type: 'output_text', text: 'visible' }],
    });
    expect(redacted.output[1]).toMatchObject({
      type: 'reasoning',
      encrypted_content: AUDIT_REDACTED,
      summary: [],
    });
    expect(redacted.output[2]).toEqual({
      type: 'compaction',
      encrypted_content: AUDIT_REDACTED,
      nested: [{ encrypted_content: AUDIT_REDACTED, safe: 7 }],
    });
    expect(redacted.metadata).toEqual({ safe: true });
    expect(JSON.stringify(redacted)).not.toContain('reasoning-secret');
    expect(JSON.stringify(redacted)).not.toContain('window-secret');
  });

  it('preserves clean JSON formatting when no encrypted_content exists', () => {
    const cleanJson = '{\n  "output": [{ "type": "message", "text": "visible" }]\n}';
    expect(redactAuditText(cleanJson)).toBe(cleanJson);
  });

  it('never throws on empty / odd input', () => {
    expect(redactAuditText('')).toBe('');
  });
});
