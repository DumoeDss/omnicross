import { parseLogJevSettings } from '@omnicross/contracts/logjev';
import type { JevMessage, JevRequest, JevResponse } from '@omnicross/contracts/logjev';

import { answerFor, buildPrompt, isObject, normalizeQuestion, parseTopLogprobs } from './protocol';
import { isOpenRouterUpstream, nativeResponse, openRouterDecisionsUrl, tokenCount, validateRequest } from './request';
import { createLimiter, createTransport } from './transport';
import { LogJevError } from './types';
import type { LogJevClientOptions, LogJevProvider } from './types';

export interface LogJevClient {
  evaluate(request: JevRequest, options?: { signal?: AbortSignal }): Promise<JevResponse>;
}

/** One instance per configured provider keeps concurrency bounded across calls. */
export function createLogJevClient(config: LogJevProvider, options: LogJevClientOptions = {}): LogJevClient {
  const provider = { ...config, ...parseLogJevSettings(config) };
  const url = new URL(provider.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('LogJev requires an HTTP(S) endpoint without URL credentials');
  if (!provider.model?.trim()) throw new Error('LogJev requires a default model');
  const limited = createLimiter(provider.concurrency ?? 4);
  const post = createTransport(provider, options.fetch ?? globalThis.fetch);
  return {
    async evaluate(raw, options = {}) {
      const request = validateRequest(raw, provider.kind);
      const model = !request.model || request.model === 'jev-latest' ? provider.model : request.model;
      const started = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.throwIfAborted();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException('LogJev evaluation timed out', 'TimeoutError')), provider.timeoutMs ?? 60_000);
      const signal = controller.signal;
      const usage = { input_tokens: 0, output_tokens: 0, reads: Object.keys(request.questions).length, upstream_requests: 0 };
      const countAttempt = () => { usage.upstream_requests++; };
      try {
        if (provider.kind === 'jev') {
          const endpoint = isOpenRouterUpstream(provider.baseUrl) ? openRouterDecisionsUrl(provider.baseUrl)
            : ['/', '/v1', '/v1/'].includes(url.pathname) ? new URL('/v1/systemone', url).href : provider.baseUrl;
          const payload = { model, questions: request.questions,
            ...(request.messages ? { messages: request.messages } : request.state != null ? { state: request.state } : {}) };
          const data = await limited(signal, () => post(endpoint, payload, signal, countAttempt));
          const result = nativeResponse(data, request, model);
          return { ...result, usage: { ...result.usage, upstream_requests: usage.upstream_requests }, latency_ms: Math.round(performance.now() - started) };
        }
        const models = new Set<string>();
        const endpoint = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const mode = request.prompt_mode ?? provider.promptMode ?? 'full';
        const history = request.messages ?? null;
        const extraBody = { ...provider.extraBody };
        // Prevent extra generation controls from changing the one-token read.
        for (const key of ['max_completion_tokens', 'tools', 'tool_choice', 'functions', 'function_call', 'response_format', 'stop']) delete extraBody[key];
        const read = async (messages: JevMessage[]) => {
          const body = { ...extraBody, model, messages, max_tokens: 1,
            temperature: provider.readTemperature ?? 1, logprobs: true,
            top_logprobs: provider.topk ?? 20, stream: false, n: 1 };
          for (let attempt = 0; attempt < 2; attempt++) {
            const data = await post(endpoint, body, signal, countAttempt);
            const u = isObject(data.usage) ? data.usage : {};
            usage.input_tokens += tokenCount(u.prompt_tokens);
            usage.output_tokens += tokenCount(u.completion_tokens);
            if (typeof data.model === 'string' && data.model) models.add(data.model);
            const top = parseTopLogprobs(Array.isArray(data.choices) ? data.choices[0] : undefined);
            if (top) return top;
          }
          throw new LogJevError('insufficient_evidence', 'LogJev requires top_logprobs; upstream returned none after a re-read');
        };
        const questions = Object.entries(request.questions).map(([id, q]) => [id, normalizeQuestion(id, q)] as const);
        const evidence: NonNullable<JevResponse['logjev']>['evidence'] = Object.create(null);
        const answers = await Promise.all(questions.map(([id, q]) => limited(signal, async () => {
          const prompt = (firm = false) => {
            const [messages, labels] = buildPrompt(request.state, q, history, mode, firm);
            if (request.images?.length) {
              messages[0] = { role: 'user', content: [{ type: 'text', text: messages[0].content as string },
                ...request.images.map(image => ({ type: 'image_url', image_url: { url: image } }))] };
            }
            return { messages, labels };
          };
          const { messages, labels } = prompt();
          let top = await read(messages);
          const count = () => labels.filter(label => Object.hasOwn(top, label)).length;
          if (!count()) top = await read(prompt(true).messages);
          if (!count()) throw new LogJevError('insufficient_evidence', `question '${id}' has no observed answer labels after a re-read`);
          evidence[id] = { observedLabels: count(), totalLabels: labels.length };
          return [id, answerFor(q, labels, top)] as const;
        })));
        return { model: models.size === 1 ? [...models][0] : model, requested_model: model,
          answers: Object.fromEntries(answers), usage, latency_ms: Math.round(performance.now() - started),
          logjev: { kind: 'chat', calibrated: false, models: [...models], evidence } };
      } finally {
        // Abort sibling requests on a failure as well as clearing the deadline.
        controller.abort();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
    },
  };
}
