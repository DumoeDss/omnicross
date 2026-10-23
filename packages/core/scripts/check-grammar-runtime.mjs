import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Source tests use TS aliases. Exercise the built public API so CJS lowering of
// the ESM-only WASM dependency cannot silently break published grammar tools.
const require = createRequire(import.meta.url);
const loaders = [
  ['CJS', (specifier) => require(specifier)],
  ['ESM', (specifier) => import(specifier)],
];
const grammars = [
  { syntax: 'lark', definition: 'start: value\n?value: "雪" | "(" value ")"\n', valid: '((雪))', invalid: '((INVALID))' },
  { syntax: 'regex', definition: String.raw`(?:MOVE|TURN) [A-Z]+\r?\n`, valid: 'MOVE NORTH\r\n', invalid: 'MOVE NORTH\r\nTRAILING' },
];

for (const [mode, load] of loaders) {
  const { OpenAIResponseTransformer } = await load('@omnicross/core/transformer/transformers/OpenAIResponseTransformer');
  const endpoint = new OpenAIResponseTransformer();
  for (const grammar of grammars) {
    const req = await endpoint.transformRequestOut({
      model: 'grammar-runtime-check',
      tools: [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: grammar.syntax, definition: grammar.definition } }],
      input: [{ role: 'user', content: 'Run the declared tool.' }],
    }, { providerName: 'grammar-runtime-check' });
    const encode = (input) => endpoint.transformResponseIn(Response.json({
      model: 'grammar-runtime-check',
      choices: [{
        message: { role: 'assistant', content: null, tool_calls: [{
          id: 'call_runtime', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ input }) },
        }] },
        finish_reason: 'tool_calls',
      }],
    }), { providerName: 'grammar-runtime-check', req });
    const response = await encode(grammar.valid);
    const body = await response.json();
    const calls = body.output.filter((item) => item.type === 'custom_tool_call');
    assert.equal(calls.length, 1, `${mode}/${grammar.syntax}: custom call was lost`);
    assert.equal(calls[0].name, 'exec');
    assert.equal(calls[0].call_id, 'call_runtime');
    assert.equal(calls[0].input, grammar.valid, `${mode}/${grammar.syntax}: input changed`);
    await assert.rejects(() => encode(grammar.invalid), { status: 502, code: 'invalid_upstream_tool_input' });
  }
}
console.log('grammar runtime check OK — built CJS/ESM enforce complete Lark/regex input');
