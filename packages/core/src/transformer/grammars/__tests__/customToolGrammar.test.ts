import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileCustomToolGrammar } from '../customToolGrammar';
import type { CustomToolGrammarFormat } from '../customToolGrammar';
import { loadLlGuidanceMatcher } from '../llguidanceWasm';

afterEach(() => vi.restoreAllMocks());

function format(syntax: 'lark' | 'regex', definition: string): CustomToolGrammarFormat {
  return { type: 'grammar', syntax, definition };
}

describe('custom tool grammar admission with bundled llguidance WASM', () => {
  it.each([
    ['lark', 'start: "\ud800"'],
    ['lark', 'start: "\udfff" | "�"'],
    ['regex', '\ud800'],
    ['regex', '[\udfff]'],
  ] as const)('rejects ill-formed UTF-16 %s definitions instead of compiling replacement text', async (syntax, definition) => {
    await expect(compileCustomToolGrammar(format(syntax, definition))).rejects.toThrow(/unpaired UTF-16 surrogate/);
  });

  it('never mistakes the EOS token vocabulary spelling for actual input bytes', async () => {
    const [literal, regex] = await Promise.all([
      compileCustomToolGrammar(format('lark', 'start: "<omnicross-eos>"')),
      compileCustomToolGrammar(format('regex', '<omnicross-eos>')),
    ]);
    for (const grammar of [literal, regex]) {
      expect(grammar.accepts('')).toBe(false);
      expect(grammar.accepts('<omnicross-eos>')).toBe(true);
      expect(grammar.accepts('<omnicross-eos>tail')).toBe(false);
    }
  });

  it.each([
    'start: <[256]>',
    'start: <[0-256]>',
    'start: <[*]>',
    'start: <|endoftext|>',
    'start: "prefix" <[256]>',
    String.raw`start: "\"" <[256]>`,
  ])('explicitly rejects model-token grammar terminals: %s', async (definition) => {
    await expect(compileCustomToolGrammar(format('lark', definition))).rejects.toThrow(/model-token terminals/);
  });

  it('does not mistake token-like text in Lark literals, regexes or comments for model terminals', async () => {
    const grammar = await compileCustomToolGrammar(format('lark', String.raw`
# <[256]> is just comment text
start: "<[256]>" | /<token>/
// <|endoftext|> is also just comment text
`));
    expect(grammar.accepts('<[256]>')).toBe(true);
    expect(grammar.accepts('<token>')).toBe(true);
    expect(grammar.accepts('')).toBe(false);
  });

  it('admits a complete fixed Lark literal, not a prefix or trailing bytes', async () => {
    const grammar = await compileCustomToolGrammar(format('lark', 'start: "hello"'));
    expect(grammar.accepts('hello')).toBe(true);
    for (const input of ['', 'hell', 'hello!', 'hello\n', ' hello', 'goodbye']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(false);
    }
    // A rejected/incomplete match cannot poison a later independent parser.
    expect(grammar.accepts('hello')).toBe(true);
  });

  it('parses recursive nested CFGs with imported terminals and ignored whitespace', async () => {
    const grammar = await compileCustomToolGrammar(format('lark', String.raw`
start: expression
?expression: INT | "(" expression ("+" expression)* ")"
%import common.INT
%import common.WS
%ignore WS
`));
    for (const input of ['42', '(1+2)', '(1 + (2 + (3+4)))', '(1\n+ 2)']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(true);
    }
    for (const input of ['', '(1+', '(1+2))', '(1+(2+))', '(1 2)', '1x', '(1\n+ 2)\t']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(false);
    }
    expect(grammar.accepts('('.repeat(32) + '1' + ')'.repeat(32))).toBe(true);
  });

  it('preserves native llguidance rejection of ignored-only trailing whitespace', async () => {
    const grammar = await compileCustomToolGrammar(format('lark', String.raw`
start: "go"
%import common.WS
%ignore WS
`));
    expect(grammar.accepts('go')).toBe(true);
    // Native check_stop emits NoExtension immediately after the final literal;
    // %ignore is not a license to normalize or append input after that state.
    for (const input of ['go ', 'go\r\n', 'go \r\n\t', 'go x', 'go\r\nx', 'g\r\no', 'go\0']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(false);
    }
  });

  it('accepts trailing whitespace when the grammar explicitly includes a trailing-WS term', async () => {
    const grammar = await compileCustomToolGrammar(format('lark', String.raw`
start: "go" TRAILING_WS?
TRAILING_WS: /[ \t\r\n]+/
`));
    for (const input of ['go', 'go ', 'go\r\n', 'go \r\n\t']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(true);
    }
    for (const input of [' go', 'go x', 'go\r\nx', 'g\r\no', 'go\0']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(false);
    }
  });

  it('supports llguidance terminal intersection and negation instead of a toy Lark subset', async () => {
    const grammar = await compileCustomToolGrammar(format('lark', String.raw`
start: IDENTIFIER
IDENTIFIER: /[a-z]+/ & ~("if" | "else")
`));
    expect(grammar.accepts('identifier')).toBe(true);
    expect(grammar.accepts('iffy')).toBe(true);
    expect(grammar.accepts('if')).toBe(false);
    expect(grammar.accepts('else')).toBe(false);
    expect(grammar.accepts('identifier!')).toBe(false);
  });

  it('uses full-string llguidance regex acceptance including Unicode classes', async () => {
    const grammar = await compileCustomToolGrammar(format('regex', String.raw`\p{Greek}{2,4}-\d{2}`));
    for (const input of ['αβ-12', 'ΩΣ-١٢', 'αβγδ-42']) {
      expect(grammar.accepts(input), input).toBe(true);
    }
    for (const input of ['', 'α-12', 'ab-12', 'αβ-1', 'αβ-123', 'αβ-12\n', 'xαβ-12', 'αβγδε-12']) {
      expect(grammar.accepts(input), JSON.stringify(input)).toBe(false);
    }
  });

  it('supports Rust named capture groups and anchors used by OpenAI regex examples', async () => {
    const grammar = await compileCustomToolGrammar(format('regex', String.raw`^(?P<word>[a-z]+):(?P<count>\d{2})$`));
    expect(grammar.accepts('count:42')).toBe(true);
    expect(grammar.accepts('count:4')).toBe(false);
    expect(grammar.accepts('count:42\n')).toBe(false);
    expect(grammar.accepts('xcount:42tail')).toBe(false);
  });

  it('retains regex inline flags and both literal and already-escaped slash delimiters', async () => {
    const unescaped = await compileCustomToolGrammar(format('regex', String.raw`(?i:hello)/world`));
    const escaped = await compileCustomToolGrammar(format('regex', String.raw`(?i:hello)\/world`));
    for (const grammar of [unescaped, escaped]) {
      expect(grammar.accepts('HELLO/world')).toBe(true);
      expect(grammar.accepts('hello/world')).toBe(true);
      expect(grammar.accepts('hello/WORLD')).toBe(false);
      expect(grammar.accepts('HELLO/world/trailing')).toBe(false);
    }
    const backslash = await compileCustomToolGrammar(format('regex', String.raw`a\\/b`));
    expect(backslash.accepts('a\\/b')).toBe(true);
    expect(backslash.accepts('a/b')).toBe(false);
  });

  it('preserves verbose regex newlines rather than rewriting them to literal newlines', async () => {
    const definition = '(?x)a # ignored comment\n / b';
    const grammar = await compileCustomToolGrammar(format('regex', definition));
    expect(grammar.accepts('a/b')).toBe(true);
    expect(grammar.accepts('a\n/b')).toBe(false);
    expect(grammar.accepts('a # ignored comment / b')).toBe(false);
  });

  it('accepts empty input only when the declared language allows it', async () => {
    const [emptyLark, emptyRegex, repeating] = await Promise.all([
      compileCustomToolGrammar(format('lark', 'start: ""')),
      compileCustomToolGrammar(format('regex', '')),
      compileCustomToolGrammar(format('regex', '(?:a|😀)*')),
    ]);
    for (const grammar of [emptyLark, emptyRegex]) {
      expect(grammar.accepts('')).toBe(true);
      expect(grammar.accepts('a')).toBe(false);
      expect(grammar.accepts('\n')).toBe(false);
    }
    expect(repeating.accepts('')).toBe(true);
    expect(repeating.accepts('a😀😀a')).toBe(true);
    expect(repeating.accepts('a😀!')).toBe(false);
  });

  it('preserves multibyte UTF-8 literals, control bytes and surrogate-pair boundaries', async () => {
    const literal = await compileCustomToolGrammar(format('lark', 'start: "é😀漢字"'));
    expect(literal.accepts('é😀漢字')).toBe(true);
    expect(literal.accepts('e😀漢字')).toBe(false);
    expect(literal.accepts('é😀漢字x')).toBe(false);

    const controls = await compileCustomToolGrammar(format('regex', String.raw`\x00\t\n\x0b\x7f`));
    expect(controls.accepts('\x00\t\n\x0b\x7f')).toBe(true);
    expect(controls.accepts('\x00\t\n\t\x7f')).toBe(false);

    const replacement = await compileCustomToolGrammar(format('regex', '�'));
    expect(replacement.accepts('�')).toBe(true);
    expect(replacement.accepts('\ud800')).toBe(false);
    expect(replacement.accepts('\udfff')).toBe(false);
  });

  it.each([
    ['lark', 'start: ['],
    ['lark', 'start: missing_rule'],
    ['lark', 'start: /a(/'],
    ['regex', '[a-z'],
    ['regex', '(?=a)a'],
    ['regex', String.raw`(a)\1`],
    ['regex', '\\'],
  ] as const)('surfaces invalid or unsupported %s syntax during compilation: %s', async (syntax, definition) => {
    await expect(compileCustomToolGrammar(format(syntax, definition))).rejects.toThrow(/Invalid .* custom tool grammar/);
  });

  it('retains a byte-exact declaration and snapshots it before subsequent caller mutations', async () => {
    const declaration = format('lark', '# exact CRLF and Unicode\r\nstart: "é"\r\n');
    const original = declaration.definition;
    const grammar = await compileCustomToolGrammar(Object.freeze(declaration));
    expect(declaration.definition).toBe(original);
    expect(grammar.accepts('é')).toBe(true);

    const mutable = format('regex', 'a+');
    const snapshot = await compileCustomToolGrammar(mutable);
    mutable.definition = 'b+';
    expect(snapshot.accepts('aaa')).toBe(true);
    expect(snapshot.accepts('bbb')).toBe(false);
  });

  it('keeps concurrent compilations and repeated interleaved matches independent', async () => {
    const declarations = Array.from({ length: 8 }, (_, index) => format('regex', `tool${index}:[0-9]+`));
    const validators = await Promise.all(declarations.map(compileCustomToolGrammar));
    for (let round = 0; round < 4; round++) {
      for (const [index, grammar] of validators.entries()) {
        expect(grammar.accepts(`tool${index}:${round}`)).toBe(true);
        expect(grammar.accepts(`tool${(index + 1) % validators.length}:${round}`)).toBe(false);
        expect(grammar.accepts(`tool${index}:`)).toBe(false);
        expect(grammar.accepts(`tool${index}:${round}!`)).toBe(false);
      }
    }
  });

  it('deterministically frees real WASM handles on compilation and every match outcome', async () => {
    const Matcher = await loadLlGuidanceMatcher();
    // Spy on real disposal without substituting any grammar engine behavior.
    const free = vi.spyOn(Matcher.prototype, 'free');
    await expect(compileCustomToolGrammar(format('lark', 'start: ['))).rejects.toThrow();
    const grammar = await compileCustomToolGrammar(format('regex', 'a+'));
    expect(grammar.accepts('aaa')).toBe(true);
    expect(grammar.accepts('aa!')).toBe(false);
    expect(grammar.accepts('')).toBe(false);
    expect(free).toHaveBeenCalledTimes(5);
  });
});
