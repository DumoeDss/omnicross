/** Shared wire contract for official Jev and LogJev's logprob-backed reader. */
export type JevJson = null | boolean | number | string | JevJson[] | { [key: string]: JevJson };
export type JevJsonObject = { [key: string]: JevJson };
export type JevPromptMode = 'full' | 'minimal';
export interface LogJevSettings {
  /** chat = OpenAI-compatible logprobs; jev = native System One endpoint. */
  kind: 'chat' | 'jev';
  /**
   * Chat-mode upstream REFERENCE (LogJev-as-selector): instead of storing
   * another key/url on this row, point at an ALREADY configured upstream —
   * a 模型服务 provider row, or an opencodego ACCOUNT pool (the zen half
   * serves the OpenAI chat wire) — and a model on it. The daemon resolves
   * credentials at call time. Only meaningful with `kind: 'chat'`; when set,
   * this row's own url/key/models are ignored.
   */
  upstream?: LogJevUpstream;
  promptMode?: JevPromptMode;
  topk?: number;
  readTemperature?: number;
  concurrency?: number;
  /** Total evaluation deadline, including queuing and retries. */
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** Nonsecret model options, e.g. chat_template_kwargs.enable_thinking. */
  extraBody?: JevJsonObject;
}
/** A chat-mode upstream reference (see `LogJevSettings.upstream`). */
export type LogJevUpstream =
  | {
      /** A 模型服务 provider row (its baseUrl/key/headers resolve at call time). */
      kind: 'provider';
      /** The referenced provider row's id. */
      id: string;
      /** The model to read logprobs from on that upstream. */
      model: string;
    }
  | {
      /** An opencodego ACCOUNT pool — the zen half serves `/v1/chat/completions`. */
      kind: 'account-pool';
      /** The subscription provider id (opencodego — the only chat-wire pool today). */
      providerId: 'opencodego';
      /** The model to read logprobs from on that upstream. */
      model: string;
    };

export interface JevMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | JevJsonObject[];
}
export type JevQuestion =
  | { type: 'choice'; instructions: JevJson; criteria: JevJsonObject }
  | { type: 'score'; instructions: JevJson; criteria: JevJson[] }
  | { type: 'noul'; instructions: JevJson };
export interface JevRequest {
  model?: string;
  state?: JevJson;
  messages?: JevMessage[];
  questions: Record<string, JevQuestion>;
  prompt_mode?: JevPromptMode;
  /** Legacy djev-spark input. Prefer messages for new multimodal callers. */
  images?: string[];
}
export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };
export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  /** Logical questions. Kept compatible with native Jev's read accounting. */
  reads: number;
  /** Actual HTTP attempts, including transport and evidence re-reads. */
  upstream_requests?: number;
  cost?: number;
}
export interface JevResponse {
  /** Upstream's actual model when available, otherwise the requested model. */
  model: string;
  requested_model?: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  latency_ms?: number;
  logjev?: {
    kind: 'chat' | 'jev';
    /** Logprob label probability is not calibrated native Jev confidence. */
    calibrated: false;
    models: string[];
    evidence: Record<string, { observedLabels: number; totalLabels: number }>;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Used by config files, admin writes and embedded consumers alike. */
export function parseLogJevSettings(value: unknown): LogJevSettings {
  if (!isRecord(value) || (value.kind !== 'chat' && value.kind !== 'jev')) {
    throw new Error('logjev.kind must be chat or jev');
  }
  const out: LogJevSettings = { kind: value.kind };
  if (value.upstream !== undefined) {
    const upstream = value.upstream;
    if (!isRecord(upstream)) throw new Error('logjev.upstream must be an object');
    const model = typeof upstream.model === 'string' ? upstream.model.trim() : '';
    if (upstream.kind === 'provider') {
      if (typeof upstream.id !== 'string' || !upstream.id.trim() || !model) {
        throw new Error('logjev.upstream must be { kind: "provider", id, model } with non-empty id and model');
      }
      out.upstream = { kind: 'provider', id: upstream.id, model };
    } else if (upstream.kind === 'account-pool') {
      if (upstream.providerId !== 'opencodego' || !model) {
        throw new Error('logjev.upstream account pools must be { kind: "account-pool", providerId: "opencodego", model }');
      }
      out.upstream = { kind: 'account-pool', providerId: 'opencodego', model };
    } else {
      throw new Error('logjev.upstream.kind must be "provider" or "account-pool"');
    }
  }
  if (value.promptMode !== undefined) {
    if (value.promptMode !== 'full' && value.promptMode !== 'minimal') {
      throw new Error('logjev.promptMode must be full or minimal');
    }
    out.promptMode = value.promptMode;
  }
  for (const [name, min, max, integer] of [
    ['topk', 1, 100, true], ['readTemperature', 0, 2, false],
    ['concurrency', 1, 32, true], ['timeoutMs', 1, 300_000, true],
  ] as const) {
    const n = value[name];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new Error(`logjev.${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
    }
    out[name] = n;
  }
  if (value.retryDelaysMs !== undefined) {
    if (!Array.isArray(value.retryDelaysMs) || value.retryDelaysMs.length > 5 ||
        value.retryDelaysMs.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 30_000)) {
      throw new Error('logjev.retryDelaysMs must contain at most 5 delays between 0 and 30000');
    }
    out.retryDelaysMs = [...value.retryDelaysMs] as number[];
  }
  if (value.extraBody !== undefined) {
    if (!isRecord(value.extraBody)) throw new Error('logjev.extraBody must be an object');
    const validate = (node: unknown, depth: number): void => {
      if (depth > 12) throw new Error('logjev.extraBody is too deeply nested');
      if (node === null || typeof node === 'string' || typeof node === 'boolean' ||
          (typeof node === 'number' && Number.isFinite(node))) return;
      if (Array.isArray(node)) { node.forEach(v => validate(v, depth + 1)); return; }
      if (!isRecord(node)) throw new Error('logjev.extraBody must contain JSON values');
      for (const [key, v] of Object.entries(node)) {
        if (/^(api[_-]?key|authorization|cookie|secret|token|password)$/i.test(key)) {
          throw new Error('logjev.extraBody cannot store credentials; use the provider API key');
        }
        validate(v, depth + 1);
      }
    };
    validate(value.extraBody, 0);
    out.extraBody = JSON.parse(JSON.stringify(value.extraBody)) as JevJsonObject;
  }
  return out;
}
