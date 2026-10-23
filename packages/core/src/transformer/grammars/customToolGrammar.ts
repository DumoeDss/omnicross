import { BYTE_TOKENIZER_JSON, EOS_TOKEN, loadLlGuidanceMatcher } from './llguidanceWasm';
import type { LlGuidanceMatcher } from './llguidanceWasm';

export type CustomToolGrammarFormat = {
  type: 'grammar';
  syntax: 'lark' | 'regex';
  definition: string;
};

export interface CompiledCustomToolGrammar {
  accepts(input: string): boolean;
}

export class InvalidCustomToolGrammarError extends Error {
  readonly name = 'InvalidCustomToolGrammarError';
}

const encoder = new TextEncoder();

export async function compileCustomToolGrammar(format: CustomToolGrammarFormat): Promise<CompiledCustomToolGrammar> {
  const { syntax, definition } = format;
  if (!isWellFormed(definition)) {
    throw new InvalidCustomToolGrammarError(
      `Invalid ${syntax} custom tool grammar: definition contains an unpaired UTF-16 surrogate`,
    );
  }
  if (syntax === 'lark') assertTextGrammar(definition);
  const Matcher = await loadLlGuidanceMatcher();
  const source = syntax === 'lark' ? definition : regexGrammar(definition);
  const grammar = JSON.stringify({ grammars: [{ lark: source }] });
  let probe: LlGuidanceMatcher | undefined;
  try {
    probe = new Matcher(grammar, BYTE_TOKENIZER_JSON);
    // Constructor failures live in Matcher::Error and surface only on a mask
    // computation. Reject them before any upstream request is sent.
    probe.is_token_allowed(EOS_TOKEN);
  } catch (cause) {
    throw new InvalidCustomToolGrammarError(`Invalid ${syntax} custom tool grammar: ${String(cause)}`, { cause });
  } finally {
    probe?.free();
  }

  return {
    accepts(input) {
      // TextEncoder would silently replace lone UTF-16 surrogates with U+FFFD.
      // That would validate different text, not the tool's exact returned input.
      if (!isWellFormed(input)) return false;

      // The pinned wrapper exposes no compiled-grammar clone API. Each match
      // therefore recompiles into its own parser, which is deterministically
      // freed, even on invalid input or an engine error. Never cache mutable
      // matchers or rely on WASM finalizers for request-scoped allocations.
      const matcher = new Matcher(grammar, BYTE_TOKENIZER_JSON);
      try {
        for (const byte of encoder.encode(input)) {
          if (hasCompleted(matcher) || !matcher.is_token_allowed(byte)) return false;
          matcher.advance(byte);
        }
        return hasCompleted(matcher) || matcher.is_token_allowed(EOS_TOKEN);
      } catch (cause) {
        throw new Error(`Failed to validate ${syntax} custom tool input: ${String(cause)}`, { cause });
      } finally {
        matcher.free();
      }
    },
  };
}

function hasCompleted(matcher: LlGuidanceMatcher): boolean {
  const reason = matcher.stop_reason();
  // NoExtension is emitted by check_stop ONLY in an accepting state that
  // cannot extend. Do not confuse it with NoExtensionBias (empty-mask error),
  // MaxTokensTotal (truncation), or the facade's overly broad isComplete().
  if (reason === 'NoExtension') return true;
  if (reason !== 'NotStopped') throw new Error(`llguidance matcher stopped: ${reason}`);
  return false;
}

function regexGrammar(definition: string): string {
  // The dependency's regex facade interpolates unescaped '/' delimiters.
  // Escape only those delimiters, preserving Rust/llguidance regex semantics,
  // including Unicode classes, inline flags and significant/verbose newlines.
  // Bare // is a Lark comment, not an empty regex terminal.
  if (definition.length === 0) return 'start: /(?:)/';
  let escaped = false;
  let source = 'start: /';
  for (const character of definition) {
    if (character === '/' && !escaped) source += '\\';
    source += character;
    escaped = character === '\\' && !escaped;
  }
  return `${source}/`;
}

function isWellFormed(input: string): boolean {
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertTextGrammar(definition: string): void {
  let delimiter: '"' | "'" | '/' | undefined;
  for (let index = 0; index < definition.length; index++) {
    const character = definition[index];
    if (delimiter !== undefined) {
      if (character === '\\') index++;
      else if (character === delimiter) delimiter = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      delimiter = character;
    } else if (character === '#' || (character === '/' && definition[index + 1] === '/')) {
      const newline = definition.indexOf('\n', index);
      if (newline === -1) break;
      index = newline;
    } else if (character === '/') {
      delimiter = '/';
    } else if (character === '<') {
      // llguidance's <name>/<id-range> extensions refer to a model tokenizer,
      // not text bytes. Our synthetic vocabulary cannot implement that contract.
      // This is only a lexical exclusion; llguidance still parses the grammar.
      throw new InvalidCustomToolGrammarError('Invalid lark custom tool grammar: model-token terminals are unsupported for text input');
    }
  }
}
