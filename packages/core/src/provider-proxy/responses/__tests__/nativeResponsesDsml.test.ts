import { afterEach, describe, expect, it } from 'vitest';
import {
  armNativeDsmlSalvage,
  resolveDeclaredName,
  salvageNativeResponsesJson,
  wrapNativeResponsesSse,
} from '../nativeResponsesDsml';
import { setDsmlSalvageMode } from '../../../transformer/transformers/utils/dsmlToolCalls';

const M = String.fromCharCode(0xff5c);
/** V4.1 spelling, doubled pipes — exactly what the 2026-10-01 capture showed. */
const T = (tag: string) => `<${M}${M}DSML${M}${M} ${tag}>`;
const C = (tag: string) => `</${M}${M}DSML${M}${M} ${tag}>`;

/** The leaking block from the real turn (Command Code → deepseek-v4.1-flash). */
const LEAK = [
  T('calls'),
  T('invoke name="exec"'),
  `${T('parameter name="input" string="true"')}$PSVersionTable.PSVersion${C('parameter')}`,
  C('invoke'),
  C('calls'),
].join('\n');

/** codex's request: every tool inside one `additional_tools` item. */
const CODEX_REQUEST = {
  model: 'deepseek/deepseek-v4.1-flash',
  stream: true,
  input: [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          tools: [{ type: 'custom', name: 'exec', description: 'Run commands' }],
        },
      ],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
  ],
};

/** The declarations the salvage should recover from CODEX_REQUEST. */
function armedDeclarations() {
  return armNativeDsmlSalvage(CODEX_REQUEST)!;
}

afterEach(() => setDsmlSalvageMode(undefined));

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

describe('armNativeDsmlSalvage', () => {
  it('arms for a deepseek model and recovers the codex declarations', () => {
    const declarations = armedDeclarations();
    expect(declarations).not.toBeNull();
    expect(declarations.customToolNames).toContain('functions__exec');
    expect(declarations.toolNamespaces['functions__exec']).toBe('functions');
  });

  it('does not arm for a non-deepseek native model', () => {
    expect(armNativeDsmlSalvage({ ...CODEX_REQUEST, model: 'gpt-6.1-sol' })).toBeNull();
  });

  it('respects the kill switch', () => {
    setDsmlSalvageMode('off');
    expect(armNativeDsmlSalvage(CODEX_REQUEST)).toBeNull();
  });

  it('also collects top-level tools[] declarations', () => {
    const declarations = armNativeDsmlSalvage({
      model: 'deepseek-v4-pro',
      tools: [{ type: 'function', name: 'wait', parameters: { type: 'object' } }],
    })!;
    expect(declarations.tools.map((t) => t.function.name)).toEqual(['wait']);
  });
});

describe('resolveDeclaredName', () => {
  it('maps the bare inner name the rebuilt-declaration model wrote to the declared flat name', () => {
    const declarations = armedDeclarations();
    // The upstream rebuilt declarations and the model wrote `exec`; codex
    // declared `functions__exec` — the suffix match must recover it.
    expect(resolveDeclaredName('exec', declarations)).toBe('functions__exec');
    expect(resolveDeclaredName('functions__exec', declarations)).toBe('functions__exec');
  });

  it('leaves an ambiguous bare name alone rather than guessing', () => {
    const declarations = armNativeDsmlSalvage({
      model: 'deepseek-flash',
      tools: [],
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'search' }] },
            { type: 'namespace', name: 'b', tools: [{ type: 'function', name: 'search' }] },
          ],
        },
      ],
    })!;
    expect(resolveDeclaredName('search', declarations)).toBe('search');
  });
});

describe('salvageNativeResponsesJson', () => {
  it('cleans the message text and appends the tool call item', () => {
    const data = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'deepseek/deepseek-v4.1-flash',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `我先运行一个只读测试。\n\n${LEAK}` }],
        },
      ],
    };
    const changed = salvageNativeResponsesJson(data, armedDeclarations());

    expect(changed).toBe(true);
    const message = data.output.find((o: any) => o.type === 'message');
    expect(message.content[0].text).toBe('我先运行一个只读测试。');
    expect(message.content[0].text).not.toContain('DSML');
    const call = data.output.find((o: any) => o.type === 'custom_tool_call');
    expect(call).toBeDefined();
    // Bare `exec` resolved back to the declared tool, with its namespace.
    expect(call.name).toBe('exec');
    expect(call.namespace).toBe('functions');
    expect(call.input).toBe('$PSVersionTable.PSVersion');
  });

  it('leaves a clean response untouched', () => {
    const data = {
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      ],
    };
    expect(salvageNativeResponsesJson(data, armedDeclarations())).toBe(false);
    expect(data.output).toHaveLength(1);
  });
});

describe('wrapNativeResponsesSse', () => {
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

  it('streams a clean turn through byte-for-byte', async () => {
    const source = [
      frame({ type: 'response.created', response: { id: 'r' } }),
      frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant' },
      }),
      frame({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
      frame({ type: 'response.output_text.done', output_index: 0, text: 'Hello' }),
      frame({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      }),
      frame({ type: 'response.completed', response: { id: 'r', output: [] } }),
    ];
    const events = await drain(wrapNativeResponsesSse(sseStream(source), armedDeclarations()));
    expect(events).toEqual(source.map((f) => JSON.parse(f.slice(5).trim())));
  });

  it('salvages a leaked DSML block end to end', async () => {
    const finalText = `我先运行一个只读测试。`;
    const source = [
      frame({ type: 'response.created', response: { id: 'r' } }),
      frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      }),
      // Prose first, then the opener split across deltas (byte-level split).
      frame({ type: 'response.output_text.delta', output_index: 0, delta: '我先运行一个只读测试。\n' }),
      frame({ type: 'response.output_text.delta', output_index: 0, delta: '<' + M + M }),
      frame({ type: 'response.output_text.delta', output_index: 0, delta: `DSML${M}${M} calls>\n` }),
      frame({ type: 'response.output_text.delta', output_index: 0, delta: `${T('invoke name="exec">')}\n` }),
      frame({
        type: 'response.output_text.delta',
        output_index: 0,
        delta: `${T('parameter name="input" string="true"')}$PSVersionTable.PSVersion${C('parameter')}\n`,
      }),
      frame({ type: 'response.output_text.delta', output_index: 0, delta: `${C('invoke')}\n${C('calls')}` }),
      frame({ type: 'response.output_text.done', output_index: 0, text: 'irrelevant' }),
      frame({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'irrelevant' }],
        },
      }),
      frame({
        type: 'response.completed',
        response: {
          id: 'r',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'irrelevant' }],
            },
          ],
        },
      }),
    ];

    const events = await drain(wrapNativeResponsesSse(sseStream(source), armedDeclarations()));

    // No markup ever streamed as text.
    const streamedText = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('');
    expect(streamedText).not.toContain('DSML');
    expect(streamedText).toBe(finalText + '\n');

    // The salvaged call rides the full item lifecycle.
    const added = events.find(
      (e) => e.type === 'response.output_item.added' && e.item?.type === 'custom_tool_call'
    );
    expect(added).toBeDefined();
    expect(added.item.name).toBe('exec');
    expect(added.item.namespace).toBe('functions');

    const inputDone = events.find((e) => e.type === 'response.custom_tool_call_input.done');
    expect(inputDone.input).toBe('$PSVersionTable.PSVersion');

    // The finalized message text matches what was streamed.
    const messageDone = events.find(
      (e) => e.type === 'response.output_item.done' && e.item?.type === 'message'
    );
    expect(messageDone.item.content[0].text).toBe(finalText + '\n');

    // completed carries both the cleaned message and the call item.
    const completed = events.find((e) => e.type === 'response.completed');
    const types = completed.response.output.map((o: any) => o.type);
    expect(types).toContain('message');
    expect(types).toContain('custom_tool_call');
    const callItem = completed.response.output.find((o: any) => o.type === 'custom_tool_call');
    expect(callItem.name).toBe('exec');
    expect(callItem.input).toBe('$PSVersionTable.PSVersion');
  });

  it('releases held-back prose when the stream ends without a terminal event', async () => {
    const source = [
      frame({ type: 'response.output_text.delta', output_index: 0, delta: 'partial answer' }),
    ];
    const events = await drain(wrapNativeResponsesSse(sseStream(source), armedDeclarations()));
    const streamed = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('');
    expect(streamed).toBe('partial answer');
  });
});
