import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DSML_SALVAGE_ENV,
  DsmlStreamSuppressor,
  dsmlSalvageMode,
  hasDsmlMarkup,
  isDeepseekName,
  isDsmlSalvageArmed,
  isDsmlSalvageEnabled,
  salvageDsmlToolCalls,
  setDsmlSalvageMode,
  stripDsmlMarkup,
  warnDsmlUnarmed,
} from '../dsmlToolCalls';

// The delimiter is U+FF5C FULLWIDTH VERTICAL LINE, built from its code point so
// this file never carries the literal markup byte sequence.
const M = String.fromCharCode(0xff5c);
/** V4.1 form — a space between the marker and the tag name. */
const T = (tag: string) => `<${M}${M}DSML${M}${M} ${tag}>`;
/** V4 form — no space. */
const T0 = (tag: string) => `<${M}${M}DSML${M}${M}${tag}>`;
const C = (tag: string) => `</${M}${M}DSML${M}${M} ${tag}>`;
const C0 = (tag: string) => `</${M}${M}DSML${M}${M}${tag}>`;

/** The exact block captured from this machine's codex rollout, verbatim. */
const CAPTURED_EXEC = [
  `${T('calls')}`,
  `${T('invoke name="functions__exec"')}`,
  `${T('parameter name="input" string="true"')}const r = await tools.exec_command({`,
  `  cmd: "echo hello",`,
  `  workdir: "E:\\\\AI\\\\ChatAI\\\\Agents\\\\VibeCodingProjects\\\\elftia\\\\waifuoid",`,
  `  yield_time_ms: 10000`,
  `});`,
  `text(JSON.stringify(r));${C('parameter')}`,
  `${C('invoke')}`,
  `${C('calls')}`,
].join('\n');

afterEach(() => setDsmlSalvageMode(undefined));

describe('hasDsmlMarkup', () => {
  it('sees the captured exec block', () => {
    expect(hasDsmlMarkup(CAPTURED_EXEC)).toBe(true);
  });

  it('ignores markup quoted inside a fenced code block', () => {
    expect(hasDsmlMarkup(['Here is what DSML looks like:', '```', CAPTURED_EXEC, '```'].join('\n')))
      .toBe(false);
  });

  it('ignores generics and comparisons that merely contain an angle bracket', () => {
    expect(hasDsmlMarkup('A List<int> and a check like if (a < b) { return; }')).toBe(false);
    expect(hasDsmlMarkup('We should talk about D and S and M and L sometime.')).toBe(false);
  });

  it('requires the opener to start its own line', () => {
    // A marker mid-sentence is a mention, not a protocol block.
    expect(hasDsmlMarkup(`the model wrote ${T('calls')} in the middle of a sentence`)).toBe(false);
  });
});

describe('salvageDsmlToolCalls — captured production sample', () => {
  it('rebuilds the exec call and leaves no markup behind', () => {
    const { calls, cleaned, sawMarkup } = salvageDsmlToolCalls(CAPTURED_EXEC);

    expect(sawMarkup).toBe(true);
    expect(cleaned).toBe('');
    expect(calls).toHaveLength(1);
    // The FLATTENED declaration name the model saw is kept — stripping the
    // namespace back off is the response encoder's job, not ours.
    expect(calls[0].name).toBe('functions__exec');
    expect(JSON.parse(calls[0].arguments)).toEqual({
      input: [
        'const r = await tools.exec_command({',
        '  cmd: "echo hello",',
        '  workdir: "E:\\\\AI\\\\ChatAI\\\\Agents\\\\VibeCodingProjects\\\\elftia\\\\waifuoid",',
        '  yield_time_ms: 10000',
        '});',
        'text(JSON.stringify(r));',
      ].join('\n'),
    });
  });
});

describe('salvageDsmlToolCalls — markup variants', () => {
  const oneCall = (opener: (tag: string) => string, closer: (tag: string) => string) =>
    [
      opener('tool_calls'),
      opener('invoke name="get_weather"'),
      opener('parameter name="city" string="true"') + 'Paris' + closer('parameter'),
      closer('invoke'),
      closer('tool_calls'),
    ].join('\n');

  it('parses the V4 form (no space after the marker)', () => {
    const { calls } = salvageDsmlToolCalls(oneCall(T0, C0));
    expect(calls).toEqual([{ name: 'get_weather', arguments: '{"city":"Paris"}' }]);
  });

  it('parses the V3.2 `function_calls` wrapper', () => {
    const block = [
      T('function_calls'),
      T('invoke name="get_weather"'),
      `${T('parameter name="city" string="true"')}Paris${C('parameter')}`,
      C('invoke'),
      C('function_calls'),
    ].join('\n');
    expect(salvageDsmlToolCalls(block).calls).toEqual([
      { name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
  });

  it('parses a BARE invoke with no block wrapper', () => {
    const block = [
      T('invoke name="get_weather"'),
      `${T('parameter name="city" string="true"')}Paris${C('parameter')}`,
      C('invoke'),
    ].join('\n');
    expect(salvageDsmlToolCalls(block).calls).toEqual([
      { name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
  });

  it('parses doubled and ASCII pipe variants', () => {
    for (const bar of [`${M}${M}`, '|', '||']) {
      const block = [
        `<${bar}DSML${bar} calls>`,
        `<${bar}DSML${bar} invoke name="get_weather">`,
        `<${bar}DSML${bar} parameter name="city" string="true">Paris</${bar}DSML${bar} parameter>`,
        `</${bar}DSML${bar} invoke>`,
        `</${bar}DSML${bar} calls>`,
      ].join('\n');
      expect(salvageDsmlToolCalls(block).calls, `bar=${JSON.stringify(bar)}`).toEqual([
        { name: 'get_weather', arguments: '{"city":"Paris"}' },
      ]);
    }
  });

  it('recovers a call whose closer never arrived', () => {
    const block = [
      T('calls'),
      T('invoke name="get_weather"'),
      `${T('parameter name="city" string="true"')}Paris`,
      C('invoke'),
    ].join('\n');
    // Unterminated parameter runs to the end of the invoke, not to end-of-text.
    expect(salvageDsmlToolCalls(block).calls).toEqual([
      { name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
  });

  it('drops one malformed invoke without losing its sibling', () => {
    const block = [
      T('calls'),
      T('invoke name="first"'),
      `${T('parameter name="a" string="false"')}not json at all`,
      C('parameter'),
      C('invoke'),
      T('invoke name="second"'),
      `${T('parameter name="b" string="true"')}ok`,
      C('parameter'),
      C('invoke'),
      C('calls'),
    ].join('\n');
    const { calls } = salvageDsmlToolCalls(block);
    expect(calls.map((c) => c.name)).toEqual(['first', 'second']);
  });
});

describe('salvageDsmlToolCalls — parameter values', () => {
  const callWithParam = (attrs: string, value: string) =>
    [
      T('calls'),
      T('invoke name="tool"'),
      `${T(`parameter ${attrs}`)}${value}${C('parameter')}`,
      C('invoke'),
      C('calls'),
    ].join('\n');

  it('honors string="false" as JSON', () => {
    const { calls } = salvageDsmlToolCalls(
      callWithParam('name="n" string="false"', '{"a":1,"b":[2,3]}')
    );
    expect(JSON.parse(calls[0].arguments)).toEqual({ n: { a: 1, b: [2, 3] } });
  });

  it('falls back to the raw text when a string="false" value is not JSON', () => {
    const { calls } = salvageDsmlToolCalls(
      callWithParam('name="n" string="false"', 'oops not json')
    );
    expect(JSON.parse(calls[0].arguments)).toEqual({ n: 'oops not json' });
  });

  it('preserves leading and trailing SPACES in a string value', () => {
    // sglang#41317: trimming here silently corrupts file bodies the agent wrote.
    const { calls } = salvageDsmlToolCalls(
      callWithParam('name="body" string="true"', '  indented line  ')
    );
    expect(JSON.parse(calls[0].arguments)).toEqual({ body: '  indented line  ' });
  });

  it('strips only the renderer newlines around a string value', () => {
    const { calls } = salvageDsmlToolCalls(
      callWithParam('name="body" string="true"', '\nhello\n')
    );
    expect(JSON.parse(calls[0].arguments)).toEqual({ body: 'hello' });
  });

  it('bounds parameters by the NEXT parameter so an unclosed one cannot absorb it', () => {
    const block = [
      T('calls'),
      T('invoke name="tool"'),
      `${T('parameter name="first" string="true"')}one`,
      `${T('parameter name="second" string="true"')}two${C('parameter')}`,
      C('invoke'),
      C('calls'),
    ].join('\n');
    expect(JSON.parse(salvageDsmlToolCalls(block).calls[0].arguments)).toEqual({
      first: 'one',
      second: 'two',
    });
  });

  it('yields empty arguments for a parameter-less invoke', () => {
    const block = [T('calls'), T('invoke name="now"'), C('invoke'), C('calls')].join('\n');
    expect(salvageDsmlToolCalls(block).calls).toEqual([{ name: 'now', arguments: '{}' }]);
  });
});

describe('salvageDsmlToolCalls — prose handling', () => {
  it('keeps the prose that preceded the block', () => {
    // Mirrors issue 909: a sentence of narration, then the markup.
    const text = `I'll run a grilling session. First, let me read the skill.\n\n${CAPTURED_EXEC}`;
    const { calls, cleaned } = salvageDsmlToolCalls(text);
    expect(cleaned).toBe("I'll run a grilling session. First, let me read the skill.");
    expect(calls).toHaveLength(1);
  });

  it('reports no markup and passes the text through untouched', () => {
    const text = 'Just a normal answer with no tool call.';
    expect(salvageDsmlToolCalls(text)).toEqual({ calls: [], cleaned: text, sawMarkup: false });
    expect(stripDsmlMarkup(text)).toBe(text);
  });
});

describe('DsmlStreamSuppressor', () => {
  it('emits whole lines and holds the incomplete tail back', () => {
    const s = new DsmlStreamSuppressor();
    expect(s.push('first line\nsecond')).toBe('first line\n');
    expect(s.capturing).toBe(false);
    expect(s.flush()).toBe('second');
  });

  it('never emits a marker that arrives split across deltas', () => {
    const s = new DsmlStreamSuppressor();
    const parts = [`prose here\n<`, M, M, 'DSML', M, M, ' calls>\n', T('invoke name="x">')];
    let emitted = '';
    for (const part of parts) emitted += s.push(part);
    // The opener line is withheld whole — a split marker can't leak as prose.
    expect(emitted).toBe('prose here\n');
    expect(s.capturing).toBe(true);
    expect(s.capturedText.startsWith('<' + M)).toBe(true);
    expect(s.flush()).toBe('');
  });

  it('captures the rest of the stream once the opener lands', () => {
    const s = new DsmlStreamSuppressor();
    s.push(`${T('calls')}\n`);
    expect(s.push(`${T('invoke name="f">')}\n`)).toBe('');
    s.push(`${T('parameter name="a" string="true"')}v${C('parameter')}\n`);
    s.push(`${C('invoke')}\n${C('calls')}`);
    // The whole block still parses from what was withheld.
    expect(salvageDsmlToolCalls(s.capturedText).calls).toEqual([
      { name: 'f', arguments: '{"a":"v"}' },
    ]);
    expect(s.flush()).toBe('');
  });

  it('releases an over-long line instead of stalling on it', () => {
    const s = new DsmlStreamSuppressor();
    const blob = 'x'.repeat(10_000);
    const out = s.push(blob);
    // The head streams as prose; only a bounded tail stays withheld.
    expect(out.length).toBeGreaterThan(0);
    expect(out + s.flush()).toBe(blob);
  });

  it('passes an ordinary stream through without loss', () => {
    const s = new DsmlStreamSuppressor();
    let emitted = s.push('Hello') + s.push(' world\n') + s.push('done');
    emitted += s.flush();
    expect(emitted).toBe('Hello world\ndone');
  });
});

describe('kill switch', () => {
  it('defaults to salvage-on for DeepSeek upstreams', () => {
    expect(dsmlSalvageMode()).toBe('deepseek');
    expect(isDsmlSalvageEnabled()).toBe(true);
  });

  it('reads the mode from the environment', () => {
    const original = process.env[DSML_SALVAGE_ENV];
    try {
      for (const [raw, expected] of [
        ['0', 'off'],
        ['off', 'off'],
        ['no', 'off'],
        ['all', 'all'],
        ['force', 'all'],
        ['1', 'deepseek'],
        ['', 'deepseek'],
      ] as const) {
        process.env[DSML_SALVAGE_ENV] = raw;
        expect(dsmlSalvageMode(), `env=${JSON.stringify(raw)}`).toBe(expected);
      }
    } finally {
      if (original === undefined) delete process.env[DSML_SALVAGE_ENV];
      else process.env[DSML_SALVAGE_ENV] = original;
    }
  });

  it('can be switched off, forced to all, and back', () => {
    setDsmlSalvageMode('off');
    expect(isDsmlSalvageEnabled()).toBe(false);
    expect(isDsmlSalvageArmed('deepseek-flash', 'DeepSeek')).toBe(false);
    setDsmlSalvageMode('all');
    expect(isDsmlSalvageEnabled()).toBe(true);
    expect(isDsmlSalvageArmed('glm-5.3', 'z.ai')).toBe(true);
    setDsmlSalvageMode('deepseek');
    expect(isDsmlSalvageArmed('glm-5.3', 'z.ai')).toBe(false);
  });
});

describe('isDsmlSalvageArmed', () => {
  it('arms on any DeepSeek-shaped name — request model, provider, or response model', () => {
    expect(isDsmlSalvageArmed('deepseek-flash', 'byo')).toBe(true);
    expect(isDsmlSalvageArmed('gpt-6.1-sol', 'DeepSeek')).toBe(true);
    // The response model survives upstream mapping that rewrote the request one.
    expect(isDsmlSalvageArmed('gpt-6.1-sol', 'byo', 'deepseek-v4.1-flash')).toBe(true);
  });

  it('stays off for non-DeepSeek upstreams', () => {
    expect(isDsmlSalvageArmed('gpt-6.1-sol', 'byo', 'glm-5.3')).toBe(false);
    expect(isDsmlSalvageArmed(undefined, undefined)).toBe(false);
  });
});

describe('warnDsmlUnarmed', () => {
  it('names the mode escape hatch, once, and never logs content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnDsmlUnarmed('some-model');
      warnDsmlUnarmed('some-model');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('some-model');
      expect(message).toContain(`${DSML_SALVAGE_ENV}=all`);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('isDeepseekName', () => {
  it('matches the DeepSeek family and nothing else', () => {
    for (const name of ['deepseek-flash', 'deepseek-v4-pro', 'DeepSeek', 'byo/deepseek-v4-pro']) {
      expect(isDeepseekName(name), name).toBe(true);
    }
    for (const name of ['gpt-6.1-sol', 'glm-5.3', 'claude-opus-5', '', undefined, 42]) {
      expect(isDeepseekName(name), String(name)).toBe(false);
    }
  });
});
