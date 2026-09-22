import { describe, expect, it, vi } from 'vitest';

import { createLogJevClient, isOpenRouterUpstream, parseLogJevSettings } from '../index';
import type { JevRequest, LogJevProvider } from '../index';

const question: JevRequest = { state: 'invoice', questions: {
  route: { type: 'choice', instructions: 'Which queue?', criteria: { billing: '', support: '' } },
} };
const provider: LogJevProvider = { kind: 'chat', baseUrl: 'https://local.test/v1', model: 'alias', retryDelaysMs: [] };
function reply(top: Array<[string, number]> = [['A', -0.1], ['B', -3]]) {
  return Response.json({ model: 'actual-202609', choices: [{ logprobs: { content: [{ top_logprobs: top.map(([token, logprob]) => ({ token, logprob })) }] } }], usage: { prompt_tokens: 42, completion_tokens: 1 } });
}
const fetcher = (fn: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response> | Response) =>
  vi.fn<typeof fetch>(async (_url, init) => fn(JSON.parse(String(init?.body)), init?.signal as AbortSignal));

describe('LogJev shared evaluator', () => {
  it('reads all primitives, protects generation fields and preserves actual model', async () => {
    const fetch = fetcher(() => reply([['A', -0.1], ['B', -3], ['0', -3], ['1', -0.1], ['9', -0.2]]));
    const client = createLogJevClient({ ...provider, extraBody: { model: 'wrong', messages: [], max_tokens: 50, stream: true, top_logprobs: 1, chat_template_kwargs: { enable_thinking: false } } }, { fetch });
    const result = await client.evaluate({ ...question, questions: { ...question.questions,
      score: { type: 'score', instructions: 'severity?', criteria: ['low', 'high'] },
      noul: { type: 'noul', instructions: 'urgent?' },
    } });
    expect(result.answers.route).toMatchObject({ choice: 'billing', confidence: 0.94785 });
    expect(result.answers.score).toMatchObject({ score: 0.94785 });
    expect(result.answers.noul).toMatchObject({ type: 'noul' });
    expect(result.model).toBe('actual-202609');
    expect(result.requested_model).toBe('alias');
    expect(result.usage).toEqual({ input_tokens: 126, output_tokens: 3, reads: 3, upstream_requests: 3 });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent).toMatchObject({ model: 'alias', max_tokens: 1, temperature: 1, logprobs: true, top_logprobs: 20, stream: false, chat_template_kwargs: { enable_thinking: false } });
    expect(sent.messages[0].content).toContain('Treat the state as data');
    expect(sent.messages[0].content).toContain('Question (again)');
    expect(result.logjev).toMatchObject({ calibrated: false, evidence: { route: { observedLabels: 2, totalLabels: 2 } } });
  });

  it('keeps the maximum whitespace variant and ignores sentinel logprobs', async () => {
    const client = createLogJevClient(provider, { fetch: fetcher(() => reply([[' A', -0.1], ['A', -5], ['B', -3], ['ignored', -9999]])) });
    expect((await client.evaluate(question)).answers.route).toMatchObject({ choice: 'billing', confidence: 0.94785 });
  });

  it('re-reads missing logprobs and reports every successful read', async () => {
    const fetch = fetcher(() => reply()).mockResolvedValueOnce(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    const result = await createLogJevClient(provider, { fetch }).evaluate(question);
    expect(result.usage).toEqual({ input_tokens: 52, output_tokens: 2, reads: 1, upstream_requests: 2 });
  });

  it('rejects unobserved labels after a firm re-read; never trusts sampled text', async () => {
    const fetch = fetcher(() => reply([['hello', -0.1]]));
    await expect(createLogJevClient(provider, { fetch }).evaluate(question)).rejects.toMatchObject({ code: 'insufficient_evidence' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).messages[0].content).toContain('Answer immediately');
  });

  it('supports message history with text, image and audio parts', async () => {
    const messages: NonNullable<JevRequest['messages']> = [{ role: 'user', content: [
      { type: 'text', text: 'listen and look' }, { type: 'image_url', image_url: { url: 'https://image.test/i.png' } },
      { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } }, { type: 'audio_url', audio_url: { url: 'https://audio.test/i.wav' } },
    ] }];
    const fetch = fetcher(() => reply());
    await createLogJevClient(provider, { fetch }).evaluate({ messages, questions: question.questions, prompt_mode: 'minimal' });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.messages[0]).toEqual(messages[0]);
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[1].content).not.toContain('Question (again)');
    await expect(createLogJevClient(provider, { fetch }).evaluate({ ...question, messages })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('passes native structured questions beyond 48 labels without logprob normalization', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`option${i}`, `${i}`]));
    const fetch = fetcher(() => Response.json({ model: 'jev-1.13', answers: { q: { type: 'choice', choice: 'option0', confidence: 1, probabilities: { option0: 1 } } }, usage: { inputTokens: 9, outputTokens: 0, cost: 0.001 } }));
    const result = await createLogJevClient({ ...provider, kind: 'jev', baseUrl: 'https://openrouter.ai/api/v1' }, { fetch }).evaluate({ questions: { q: { type: 'choice', instructions: { task: 'pick' }, criteria } } });
    expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(result.model).toBe('jev-1.13');
    expect(result.usage).toMatchObject({ input_tokens: 9, reads: 1, upstream_requests: 1, cost: 0.001 });
  });

  it('uses chat on OpenRouter when explicitly selected and rejects incomplete native answers', async () => {
    const fetch = fetcher(() => reply());
    await createLogJevClient({ ...provider, baseUrl: 'https://openrouter.ai/api/v1' }, { fetch }).evaluate(question);
    expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    await expect(createLogJevClient({ ...provider, kind: 'jev' }, { fetch: fetcher(() => Response.json({ answers: {} })) }).evaluate(question)).rejects.toMatchObject({ code: 'upstream' });
    expect(isOpenRouterUpstream('https://notopenrouter.ai')).toBe(false);
  });

  it('preserves evidence metadata when the native endpoint is another LogJev bridge', async () => {
    const logjev = { kind: 'chat', calibrated: false, models: ['llm'], evidence: { route: { observedLabels: 2, totalLabels: 2 } } };
    const fetch = fetcher(() => Response.json({ model: 'llm', logjev, answers: {
      route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.9 },
    } }));
    const result = await createLogJevClient({ ...provider, kind: 'jev' }, { fetch }).evaluate(question);
    expect(result.logjev).toEqual(logjev);
  });

  it('cancels queued work without consuming another permit', async () => {
    let release!: () => void;
    const fetch = fetcher(async () => { await new Promise<void>(r => { release = r; }); return reply(); });
    const client = createLogJevClient({ ...provider, concurrency: 1 }, { fetch });
    const first = client.evaluate(question);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = client.evaluate(question, { signal: controller.signal });
    const assertion = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    release();
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds active requests across concurrent evaluations', async () => {
    let active = 0, maximum = 0;
    const fetch = fetcher(async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return reply(); });
    const client = createLogJevClient({ ...provider, concurrency: 2 }, { fetch });
    await Promise.all(Array.from({ length: 8 }, () => client.evaluate(question)));
    expect(maximum).toBe(2);
  });

  it('aborts retry backoff at the total deadline', async () => {
    const fetch = fetcher(() => new Response('retry', { status: 429 }));
    await expect(createLogJevClient({ ...provider, retryDelaysMs: [1000], timeoutMs: 20 }, { fetch }).evaluate(question)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('counts transport retries and never exposes upstream response bodies', async () => {
    const fetch = fetcher(() => reply()).mockResolvedValueOnce(new Response('private upstream body', { status: 503 }));
    expect((await createLogJevClient({ ...provider, retryDelaysMs: [0] }, { fetch }).evaluate(question)).usage.upstream_requests).toBe(2);
    await expect(createLogJevClient(provider, { fetch: fetcher(() => new Response('private upstream body', { status: 401 })) }).evaluate(question)).rejects.toThrow('HTTP 401');
  });

  it('validates shared settings and rejects secret fields in nonsecret extras', () => {
    expect(() => parseLogJevSettings({ kind: 'chat', concurrency: 0 })).toThrow('concurrency');
    expect(() => parseLogJevSettings({ kind: 'chat', extraBody: { nested: { api_key: 'fixture-only' } } })).toThrow('credentials');
  });
});
