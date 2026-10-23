import type { TokenizerData } from 'transformers-llguidance';

export interface LlGuidanceMatcher {
  is_token_allowed(token: number): boolean;
  advance(token: number): void;
  stop_reason(): string;
  free(): void;
}

export interface LlGuidanceMatcherConstructor {
  readonly prototype: LlGuidanceMatcher;
  new (grammar: string, tokenizer: string): LlGuidanceMatcher;
}

export const EOS_TOKEN = 256;

// The pinned WASM wrapper decodes U+0180..U+01FF to bytes 128..255.
// ASCII (including controls) is already byte-exact. Do not use GPT-2's full
// alphabet here: this package's decoder only implements part of that alphabet.
const vocab: Record<string, number> = {};
for (let byte = 0; byte < 256; byte++) {
  vocab[String.fromCodePoint(byte < 128 ? byte : 0x100 + byte)] = byte;
}
vocab['<omnicross-eos>'] = EOS_TOKEN;
const tokenizer: TokenizerData = {
  vocab,
  eos_token_id: EOS_TOKEN,
  added_tokens: [{
    id: EOS_TOKEN,
    content: '<omnicross-eos>',
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
  }],
};
export const BYTE_TOKENIZER_JSON = JSON.stringify(tokenizer);

let constructorPromise: Promise<LlGuidanceMatcherConstructor> | undefined;

export function loadLlGuidanceMatcher(): Promise<LlGuidanceMatcherConstructor> {
  constructorPromise ??= initialize();
  return constructorPromise;
}

async function initialize(): Promise<LlGuidanceMatcherConstructor> {
  // Dynamic import is required: the dependency is ESM-only, including when our
  // caller is the published CJS entrypoint. Its WASM is an inline data URL; no
  // model, HuggingFace dependency, filesystem asset copy, or fetch is needed.
  const module = await import('transformers-llguidance');
  if (!('__tla' in module)) throw new Error('Unsupported llguidance module initialization ABI');
  await module.__tla;
  const parser = await module.GuidanceParser.create({ type: 'lark', grammar: 'start: ""' }, tokenizer);

  // transformers-llguidance@0.2.1's public facade omits deterministic disposal,
  // synchronous construction, and true acceptance. Localize access to its
  // wasm-bindgen handle here; upgrades MUST recheck this private ABI and decoder.
  const internalParser = parser as unknown as { wasmParser: LlGuidanceMatcher };
  const raw = internalParser.wasmParser;
  try {
    return raw.constructor as unknown as LlGuidanceMatcherConstructor;
  } finally {
    raw.free();
  }
}
