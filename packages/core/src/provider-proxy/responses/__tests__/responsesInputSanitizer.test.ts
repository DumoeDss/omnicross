/**
 * responsesInputSanitizer — the egress repair for strict Responses upstreams.
 *
 * Every case below was measured against the live upstream
 * (`api.commandcode.ai/provider/v1/responses`) by replaying the exact `input`
 * array and recording its status; the test names carry that status so a future
 * change that "simplifies" a rule fails loudly instead of silently reopening a
 * 400. See the module doc for the rule set the upstream enforces.
 *
 * @module provider-proxy/responses/__tests__/responsesInputSanitizer.test
 */
import { describe, expect, it } from 'vitest';

import { sanitizeResponsesInput, sanitizeResponsesRequest } from '../responsesInputSanitizer';

// ---------------------------------------------------------------------------
// Item builders matching what a live client actually sends
// ---------------------------------------------------------------------------

const U = (text = 'hi') => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const A = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
const R = () => ({
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'think' }],
  encrypted_content: 'gAAAAA',
});
const C = (id: string) => ({
  type: 'function_call',
  id: `fc_${id}`,
  status: 'completed',
  call_id: id,
  name: 'exec',
  arguments: '{}',
});
const O = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'done' });
const CC = (id: string) => ({
  type: 'custom_tool_call',
  id: `ctc_${id}`,
  status: 'completed',
  call_id: id,
  name: 'exec',
  namespace: 'functions',
  input: 'echo hi',
});
const CO = (id: string) => ({ type: 'custom_tool_call_output', call_id: id, output: 'done' });

/** Compact view of an item list: `u`ser, `a`ssistant, `r`easoning, `c`all, `o`utput. */
function shape(items: readonly unknown[]): string {
  return items
    .map((item) => {
      const record = item as Record<string, unknown>;
      const type = record.type;
      if (type === 'message') return record.role === 'user' ? 'u' : 'a';
      if (type === 'reasoning') return 'r';
      if (type === 'function_call') return 'c';
      if (type === 'custom_tool_call') return 'C';
      if (type === 'function_call_output') return 'o';
      if (type === 'custom_tool_call_output') return 'O';
      return '?';
    })
    .join('');
}

describe('sanitizeResponsesInput — shapes the upstream already accepts (must be untouched)', () => {
  // Each of these returned 200 from the live upstream; the sanitizer must be a
  // byte-identical no-op so working traffic is never rewritten.
  const accepted: Array<[string, unknown[]]> = [
    ['a clean tool pair', [U(), C('a'), O('a')]],
    ['a parallel block', [U(), C('a'), C('b'), O('a'), O('b')]],
    ['parallel block, outputs reversed', [U(), C('a'), C('b'), O('b'), O('a')]],
    ['message before a call', [U(), A('lead in'), C('a'), O('a')]],
    ['message after a closed block', [U(), C('a'), O('a'), A('after')]],
    ['two sequential closed blocks', [U(), C('a'), O('a'), C('b'), O('b')]],
    ['reasoning before a call', [U(), R(), C('a'), O('a')]],
    ['reasoning after a closed block', [U(), C('a'), O('a'), R()]],
    ['a custom-tool pair', [U(), CC('a'), CO('a')]],
    ['a block then a user turn', [U(), C('a'), O('a'), U('next')]],
    ['lead-in then call/output then closing text', [U(), R(), C('a'), O('a'), A('done')]],
    ['a block closed then reopened by another block', [U(), C('a'), O('a'), A('x'), C('b'), O('b')]],
  ];

  for (const [name, input] of accepted) {
    it(`leaves ${name} as-is`, () => {
      const before = shape(input);
      const after = sanitizeResponsesInput(input as unknown[]);
      expect(shape(after)).toBe(before);
      expect(after).toEqual(input);
    });
  }
});

describe('sanitizeResponsesInput — message inside a tool block (400 → repaired)', () => {
  // Measured 400: `[call, message, output]`, `[call, empty-message, output]`,
  // `[call, user, output]`, and a message in the MIDDLE of a parallel block.
  it('moves an assistant message out from between a call and its output', () => {
    // Moved BEFORE the call — the order a genuine stream and the official API
    // both produce, and one the strict upstream accepts.
    const out = sanitizeResponsesInput([U(), C('a'), A('wrapped'), O('a')]);
    expect(shape(out)).toBe('uaco');
  });

  it('repairs the poisoned order a session rollout recorded (custom tool call)', () => {
    // The exact shape found in a real codex rollout: the salvage picked a
    // malformed tool argument, the assistant then explained the failure, and a
    // retry followed — leaving [call, message, output] on disk.
    const out = sanitizeResponsesInput([U(), CC('a'), A('wrapped'), CO('a')]);
    expect(shape(out)).toBe('uaCO');
  });

  it('pulls a user message out of a tool block too', () => {
    const out = sanitizeResponsesInput([U(), C('a'), U('mid'), O('a')]);
    expect(shape(out)).toBe('uuc o'.replace(/ /g, ''));
  });

  it('breaks a parallel block around a message, keeping both blocks closed', () => {
    // [call a, message, call b, out a, out b] — the message splits the block;
    // after repair it sits before the calls it interrupted, so no item is ever
    // wedged inside a call/output run.
    const out = sanitizeResponsesInput([U(), C('a'), A('mid'), C('b'), O('a'), O('b')]);
    expect(shape(out)).toBe('uaccoo');
  });

  it('moves a reasoning item out of a tool block', () => {
    const out = sanitizeResponsesInput([U(), C('a'), R(), O('a')]);
    expect(shape(out)).toBe('urco');
  });

  it('drops an empty assistant message instead of deferring it', () => {
    const out = sanitizeResponsesInput([U(), C('a'), A(''), O('a')]);
    expect(shape(out)).toBe('uco');
  });
});

describe('sanitizeResponsesInput — orphaned calls and outputs are PRESERVED', () => {
  // The strict upstream refuses an unanswered call or an uncalled output (all
  // measured 400). They are still passed through untouched, because an orphan
  // is legitimate elsewhere: a hosted-image continuation sends a synthetic
  // `function_call_output` receipt for a call the previous turn made, and
  // dropping it silently corrupts that conversation. An orphan cannot be
  // repaired into a valid pair, so the choice is "leave it" or "mangle a
  // working route" — and leaving it is also what keeps an unterminated block
  // from being rearranged.
  it('passes an unanswered call through untouched', () => {
    expect(shape(sanitizeResponsesInput([U(), C('a')]))).toBe('uc');
  });

  it('passes a call with no answer before a user turn through untouched', () => {
    expect(shape(sanitizeResponsesInput([U(), C('a'), U('next')]))).toBe('ucu');
  });

  it('passes an output with no matching call through untouched (hosted-image receipt)', () => {
    // The shape `responsesHostedImageIngress` injects on a continuation turn.
    const receipt = {
      type: 'function_call_output',
      call_id: 'call_private_receipt_wire_1',
      output: '{"status":"completed","image_generation_call_id":"ig_1"}',
    };
    const out = sanitizeResponsesInput([receipt, U('continue with public text')]);
    expect(out).toEqual([receipt, U('continue with public text')]);
    expect(shape(out)).toBe('ou');
  });

  it('passes uncalled outputs following a valid block through untouched', () => {
    expect(shape(sanitizeResponsesInput([U(), C('a'), O('a'), O('b')]))).toBe('ucoo');
  });

  it('keeps an unanswered call alongside the pair that did close', () => {
    // [call a, call b, out a] — b is never answered; nothing is dropped and the
    // block is not rearranged.
    const out = sanitizeResponsesInput([U(), C('a'), C('b'), O('a')]);
    expect(shape(out)).toBe('ucco');
  });

  it('keeps mismatched call/output ids verbatim', () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
    const out = { type: 'custom_tool_call_output', call_id: 'custom_1', output: 'result' };
    expect(sanitizeResponsesInput([U(), call, out])).toEqual([U(), call, out]);
  });

  it('leaves a call with no usable call_id in place', () => {
    const broken = { type: 'function_call', name: 'exec', arguments: '{}' };
    expect(shape(sanitizeResponsesInput([U(), broken, O('a')]))).toBe('uco');
  });
});

describe('sanitizeResponsesInput — empty assistant text (400 → repaired)', () => {
  // Measured 400: an empty assistant message directly in front of a tool block,
  // and between two blocks. Measured 200: standalone, or before a user turn —
  // but those two are ALSO dropped, not for correctness: a textless message
  // carries nothing for the model, so removing it everywhere is simpler than
  // tracking whether a block follows, and it cannot change what the model sees.
  it('drops an empty assistant message in front of a tool block', () => {
    expect(shape(sanitizeResponsesInput([U(), A(''), C('a'), O('a')]))).toBe('uco');
  });

  it('drops an empty assistant message between two blocks', () => {
    expect(shape(sanitizeResponsesInput([U(), C('a'), O('a'), A(''), C('b'), O('b')]))).toBe(
      'ucoco',
    );
  });

  it('drops a trailing empty assistant message', () => {
    expect(shape(sanitizeResponsesInput([U(), A('')]))).toBe('u');
  });

  it('drops an empty assistant message before a user turn', () => {
    expect(shape(sanitizeResponsesInput([U(), A(''), U('next')]))).toBe('uu');
  });

  it('drops a leading empty assistant message', () => {
    expect(shape(sanitizeResponsesInput([A(''), U()]))).toBe('u');
  });

  it('treats a message with empty content array as empty', () => {
    const empty = { type: 'message', role: 'assistant', content: [] };
    expect(shape(sanitizeResponsesInput([U(), empty, C('a'), O('a')]))).toBe('uco');
  });

  it('treats a bare empty string content as empty', () => {
    const empty = { type: 'message', role: 'assistant', content: '' };
    expect(shape(sanitizeResponsesInput([U(), empty, C('a'), O('a')]))).toBe('uco');
  });

  it('keeps a USER message with empty content — only assistant text is the trigger', () => {
    const emptyUser = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] };
    const out = sanitizeResponsesInput([U(), emptyUser, C('a'), O('a')]);
    expect(shape(out)).toBe('uuco');
  });
});

describe('sanitizeResponsesInput — composition and safety', () => {
  it('repairs a history that combines every violation at once', () => {
    const out = sanitizeResponsesInput([
      U('start'),
      A(''), // empty text before a block
      C('a'),
      A('wrapped'), // message inside the block
      O('a'),
      O('zzz'), // orphan output
      C('b'), // unanswered call
      U('resume'),
    ]);
    // Only the textless message goes. The block's prose is hoisted ahead of the
    // call it interrupted; the orphan output and the unanswered call are left
    // exactly where the caller put them.
    expect(shape(out)).toBe('uacoocu');
    // Nothing load-bearing was invented or lost: the two real user turns and
    // the block's prose all survive.
    const texts = out.map((item) => JSON.stringify(item));
    expect(texts.some((t) => t.includes('start'))).toBe(true);
    expect(texts.some((t) => t.includes('resume'))).toBe(true);
    expect(texts.some((t) => t.includes('wrapped'))).toBe(true);
  });

  it('is idempotent — a repaired input is already accepted', () => {
    const once = sanitizeResponsesInput([U(), C('a'), A('mid'), O('a'), A(''), C('b')]);
    const twice = sanitizeResponsesInput(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate the caller’s array or items', () => {
    const input = [U(), C('a'), A('mid'), O('a')];
    const snapshot = JSON.stringify(input);
    sanitizeResponsesInput(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('passes non-record items through untouched', () => {
    expect(sanitizeResponsesInput(['raw-string', 42])).toEqual(['raw-string', 42]);
  });

  it('handles an empty input', () => {
    expect(sanitizeResponsesInput([])).toEqual([]);
  });
});

describe('sanitizeResponsesRequest', () => {
  it('rewrites only `input`', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek/deepseek-v4.1-flash',
      input: [U(), CC('a'), A('wrapped'), CO('a')],
      stream: false,
      store: false,
      reasoning: { effort: 'xhigh' },
      tools: [{ type: 'function', name: 'exec' }],
    };
    const out = sanitizeResponsesRequest(body);
    expect(out).toBe(body);
    expect(shape(body.input as unknown[])).toBe('uaCO');
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(body.stream).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(body.tools).toEqual([{ type: 'function', name: 'exec' }]);
  });

  it('leaves a body without an input array alone', () => {
    const body = { model: 'm', input: 'not-an-array' };
    expect(sanitizeResponsesRequest(body)).toBe(body);
    expect(body.input).toBe('not-an-array');
  });
});
