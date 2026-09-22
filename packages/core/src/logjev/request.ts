import type { JevAnswer, JevRequest, JevResponse } from '@omnicross/contracts/logjev';

import { isObject } from './protocol';
import { LogJevError } from './types';

function invalid(message: string): never { throw new LogJevError('invalid_request', message); }

function validContent(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value) && value.length > 0 && value.every(part => isObject(part) && (
    part.type === 'text' && typeof part.text === 'string' ||
    part.type === 'image_url' && isObject(part.image_url) && typeof part.image_url.url === 'string' && !!part.image_url.url.trim() ||
    part.type === 'audio_url' && isObject(part.audio_url) && typeof part.audio_url.url === 'string' && !!part.audio_url.url.trim() ||
    part.type === 'input_audio' && isObject(part.input_audio) &&
      typeof part.input_audio.data === 'string' && !!part.input_audio.data.trim() &&
      typeof part.input_audio.format === 'string' && !!part.input_audio.format.trim()
  ));
}

export function validateRequest(raw: unknown, kind: 'chat' | 'jev'): JevRequest {
  if (!isObject(raw)) invalid('body must be a JSON object');
  if (raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim())) invalid('model must be a non-empty string');
  if (raw.state != null && raw.messages != null) invalid('provide either state or messages, not both');
  if (raw.prompt_mode !== undefined && raw.prompt_mode !== 'minimal' && raw.prompt_mode !== 'full') invalid('prompt_mode must be full or minimal');
  if (raw.messages != null) {
    if (!Array.isArray(raw.messages) || !raw.messages.length || !raw.messages.every(m =>
      isObject(m) && ['system', 'user', 'assistant'].includes(String(m.role)) && validContent(m.content))) {
      invalid('messages must contain system/user/assistant messages with text, image_url, input_audio or audio_url content');
    }
  }
  if (raw.images !== undefined) {
    if (!Array.isArray(raw.images) || raw.images.length > 4 || raw.images.some(v =>
      typeof v !== 'string' || !/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+$/.test(v))) {
      invalid('images must contain at most 4 base64 image data URLs');
    }
    if (raw.images.length && (kind === 'jev' || raw.messages != null)) {
      invalid('legacy images require chat mode with state; use messages for native multimodal input');
    }
  }
  if (!isObject(raw.questions) || !Object.keys(raw.questions).length || Object.keys(raw.questions).length > 128) {
    invalid('questions must be a non-empty object with at most 128 entries');
  }
  for (const [id, q] of Object.entries(raw.questions)) {
    if (!isObject(q) || !['choice', 'score', 'noul'].includes(String(q.type))) invalid(`question '${id}' has an invalid type`);
    if (!(typeof q.instructions === 'string' && q.instructions.trim()) &&
        !(kind === 'jev' && isObject(q.instructions) && Object.keys(q.instructions).length)) {
      invalid(`question '${id}'.instructions must be ${kind === 'jev' ? 'text or an object' : 'non-empty text'}`);
    }
    if (q.type === 'choice' && (!isObject(q.criteria) || !Object.keys(q.criteria).length ||
        Object.keys(q.criteria).length > (kind === 'jev' ? 255 : 48))) invalid(`question '${id}' has invalid choice criteria (max ${kind === 'jev' ? 255 : 48})`);
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) invalid(`question '${id}' requires 2-10 score levels`);
  }
  return raw as unknown as JevRequest;
}

export function isOpenRouterUpstream(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch { return false; }
}
export function openRouterDecisionsUrl(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/api/alpha/decisions`;
}
export const tokenCount = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;

export function mapDecisionsResponse(data: Record<string, unknown>, questionCount: number): Record<string, unknown> {
  const usage = isObject(data.usage) ? data.usage : {};
  return { ...data, usage: {
    input_tokens: tokenCount(usage.input_tokens ?? usage.inputTokens),
    output_tokens: tokenCount(usage.output_tokens ?? usage.outputTokens),
    reads: typeof usage.reads === 'number' ? tokenCount(usage.reads) : questionCount,
    ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { cost: usage.cost } : {}),
  } };
}

/** Reject incomplete or untyped responses before any consumer uses the result. */
export function nativeResponse(data: Record<string, unknown>, request: JevRequest, model: string): JevResponse {
  if (!isObject(data.answers)) throw new LogJevError('upstream', 'Jev response is missing answers');
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const [id, q] of Object.entries(request.questions)) {
    const a = data.answers[id];
    const fail = () => { throw new LogJevError('upstream', `Jev response has an invalid answer for '${id}'`); };
    if (!isObject(a) || a.type !== q.type) fail();
    const answer = a as Record<string, unknown>;
    const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
    if (q.type === 'noul') {
      if (!finite(answer.noul, 0, 1)) fail();
    } else {
      if (!finite(answer.confidence, 0, 1) || !isObject(answer.probabilities) ||
          !Object.keys(answer.probabilities).length || Object.values(answer.probabilities).some(p => !finite(p, 0, 1))) fail();
      if (q.type === 'choice' && (typeof answer.choice !== 'string' || !Object.hasOwn(q.criteria, answer.choice))) fail();
      if (q.type === 'score' && !finite(answer.score, 0, q.criteria.length - 1)) fail();
    }
    answers[id] = answer as unknown as JevAnswer;
  }
  const mapped = mapDecisionsResponse(data, Object.keys(request.questions).length);
  let provenance: JevResponse['logjev'];
  // A native endpoint may itself be an Omnicross/LogJev bridge. Preserve its
  // evidence warning across the gateway instead of relabeling it as native AI.
  if (data.logjev !== undefined) {
    const meta = data.logjev;
    if (!isObject(meta) || meta.kind !== 'chat' || meta.calibrated !== false ||
        !Array.isArray(meta.models) || meta.models.some(m => typeof m !== 'string') ||
        !isObject(meta.evidence)) throw new LogJevError('upstream', 'Invalid LogJev provenance');
    const evidence: NonNullable<JevResponse['logjev']>['evidence'] = Object.create(null);
    for (const id of Object.keys(request.questions)) {
      const e = meta.evidence[id];
      if (!isObject(e) || typeof e.observedLabels !== 'number' || typeof e.totalLabels !== 'number' ||
          !Number.isInteger(e.observedLabels) || !Number.isInteger(e.totalLabels) ||
          e.observedLabels < 1 || e.totalLabels < e.observedLabels || e.totalLabels > 48) {
        throw new LogJevError('upstream', 'Invalid LogJev label coverage');
      }
      evidence[id] = { observedLabels: e.observedLabels, totalLabels: e.totalLabels };
    }
    provenance = { kind: 'chat', calibrated: false, models: meta.models as string[], evidence };
  }
  return { model: typeof data.model === 'string' && data.model ? data.model : model,
    requested_model: model, answers, usage: mapped.usage as JevResponse['usage'],
    ...(provenance ? { logjev: provenance } : {}) };
}
