/**
 * jevSystemone — the Jev systemone decision API, mounted on the daemon's
 * OUTBOUND (client traffic) server at the canonical `POST /v1/systemone`, so
 * Jev-cu and every other Jev client points at
 * `http://127.0.0.1:8765/v1/systemone` (default outbound port) exactly like
 * they would at api.typesafe.ai. Auth follows the Jev wire convention: the
 * `Authorization: Bearer <key>` must be one of omnicross's named ACCESS KEYS
 * (the same keys CLI clients use), hashed via core's `hashKey`.
 *
 * HOW IT READS (verified against NIM's hosted DiffusionGemma on 2026-09-20 —
 * see _others/jev/nim-jev-test for the probe program):
 *  - one chat-completions call per question: a single user message shaped so
 *    the FIRST token is the answer position ("Answer with one letter / one
 *    digit"), `max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20`;
 *  - the label softmax runs over the allowed labels only; labels outside the
 *    returned top-k get a floor of `min(top) - 5` (the djev-spark trick);
 *  - an assistant prefill is NOT usable (collapses to <eos> on NIM), and the
 *    base /v1/completions surface is 404 there — hence the chat-face read;
 *  - upstream 429/5xx are transient on NIM → bounded exponential-backoff retry.
 *
 * WHICH UPSTREAM: the provider row to read through is the 'other'-category row
 * (prefer id `open-jev`), created from the open-jev preset under LLM Providers
 * → Other. Two upstream kinds, picked by the row's baseUrl:
 *  - any OpenAI-compatible chat API that returns top_logprobs (default
 *    preset: NIM DiffusionGemma) → the boundary-read path above;
 *  - OpenRouter (host openrouter.ai) → NATIVE passthrough: OpenRouter serves
 *    the real Jev on its Decisions API (`POST
 *    https://openrouter.ai/api/alpha/decisions`, verified against
 *    @openrouter/sdk 1.3.8's alphaDecisionsCreate), so the request forwards
 *    verbatim and its answers return untouched — no logprobs trick needed.
 *    Models: `typesafe/jev-1.13` / `typesafe/jev-latest`. The row never
 * routes chat traffic (category 'other' is excluded from the bindable
 * catalog); its models list — fillable via Discover models (/v1/models) —
 * supplies the default read model, overridable per request via `model`
 * (the Jev alias `jev-latest` maps to the default).
 */
import type http from 'node:http';

import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import { hashKey, type OutboundKeyDb } from '@omnicross/core';
import { loadConfig } from './config';
import { resolveEnvKey } from './pool/resolveEnvKey';

/** choice labels: A–Z then a–x (Simple Jev's 48-label space). */
const LETTERS = [...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 22 }, (_, i) => String.fromCharCode(97 + i))];
const NOUL_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const TOP_K = 20;
const FLOOR_GAP = 5;
const RETRY_DELAYS_MS = [800, 2000, 5000];

interface JevQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  keys?: string[];
  criteria?: Record<string, unknown>;
  levels?: string[];
}

class JevBadRequest extends Error {}
class JevUpstreamError extends Error {}

// ── question normalization + prompt shaping ──────────────────────────────────

function normalizeQuestion(qid: string, raw: unknown): JevQuestion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JevBadRequest(`question '${qid}' must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const type = value['type'];
  const instructions = value['instructions'];
  if (type !== 'choice' && type !== 'score' && type !== 'noul') {
    throw new JevBadRequest(`question '${qid}'.type must be choice|score|noul`);
  }
  if (typeof instructions !== 'string' || !instructions.trim()) {
    throw new JevBadRequest(`question '${qid}'.instructions is required`);
  }
  if (type === 'choice') {
    const criteria = value['criteria'];
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new JevBadRequest(`question '${qid}'.criteria must be a non-empty object`);
    }
    const keys = Object.keys(criteria);
    if (keys.length === 0 || keys.length > LETTERS.length) {
      throw new JevBadRequest(`question '${qid}' needs 1..${LETTERS.length} options`);
    }
    return { type, instructions, keys, criteria: criteria as Record<string, unknown> };
  }
  if (type === 'score') {
    const criteria = value['criteria'];
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
      throw new JevBadRequest(`question '${qid}'.criteria must be an ordered list of 2-10 levels`);
    }
    return { type, instructions, levels: criteria.map((x) => String(x)) };
  }
  return { type, instructions };
}

/** djev-spark's extension shape: an `images` array of data: URLs beside the
 *  state. Validated hard (data: prefix only — no http fetches, no paths). */
function extractImages(body: Record<string, unknown>): string[] {
  const raw = body['images'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new JevBadRequest('images must be an array of data: URLs');
  const urls = raw.filter((x): x is string => typeof x === 'string' && x.startsWith('data:'));
  if (urls.length !== raw.length) throw new JevBadRequest('every image must be a data: URL');
  if (urls.length > MAX_IMAGES) throw new JevBadRequest(`at most ${MAX_IMAGES} images per request`);
  return urls;
}

/** Max images per request (size/cost guard; the upstream enforces its own
 *  payload limits on top). */
const MAX_IMAGES = 4;

/**
 * Request content + allowed labels. Enumerating the candidate letters
 * measurably keeps them inside the returned top-k (real-NIM finding).
 *
 * IMAGES (verified multimodal on NIM diffusiongemma 2026-09-20: image parts
 * are consumed — prompt tokens jump 32 → 290 for a 16×16 PNG — and the
 * boundary read works verbatim): djev-spark's extension shape, an `images`
 * array of data: URLs beside `state`. TEXT FIRST, IMAGES AFTER — that order
 * gave the cleanest label distribution in the probes (A:-0.00 vs B:-7.57);
 * image-first left the labels mid-pack.
 */
function buildPrompt(
  state: unknown,
  q: JevQuestion,
  images: string[],
): { content: string | Array<Record<string, unknown>>; labels: string[] } {
  const parts: string[] = [];
  const stateText =
    typeof state === 'string'
      ? state.trim()
      : state === null || state === undefined
        ? ''
        : JSON.stringify(state);
  if (stateText) parts.push(`State: ${stateText}`);
  parts.push(`Question: ${q.instructions}`);
  if (q.type === 'choice') {
    const opts = (q.keys as string[])
      .map((k, i) => {
        const desc = q.criteria?.[k];
        return `${LETTERS[i]}) ${k}${desc ? ` — ${String(desc)}` : ''}`;
      })
      .join('  ');
    parts.push(`Options: ${opts}`);
    const letters = LETTERS.slice(0, (q.keys as string[]).length);
    const shown = letters.slice(0, 6).join(', ') + (letters.length > 6 ? ', …' : '');
    parts.push(`Answer with one letter (${shown}).`);
    return withImages(parts.join('\n'), images, letters);
  }
  if (q.type === 'score') {
    const levels = (q.levels as string[]).map((lvl, i) => `${i}=${lvl}`).join(', ');
    parts.push(`Levels (low to high): ${levels}`);
    parts.push(`Answer with one digit from 0 to ${(q.levels as string[]).length - 1}.`);
    return withImages(parts.join('\n'), images, (q.levels as string[]).map((_, i) => String(i)));
  }
  parts.push('Answer with one digit: 1 = clearly no, 9 = clearly yes.');
  return withImages(parts.join('\n'), images, [...NOUL_DIGITS]);
}

/** Wrap the text prompt with image parts (text first — see buildPrompt). */
function withImages(
  text: string,
  images: string[],
  labels: string[],
): { content: string | Array<Record<string, unknown>>; labels: string[] } {
  if (images.length === 0) return { content: text, labels };
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text }];
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return { content: parts, labels };
}

// ── distribution math ────────────────────────────────────────────────────────

type TopMap = Map<string, number>;

/** Both top_logprobs shapes: array [{token, logprob}] (NIM) and map (OpenAI spec). */
function parseTopLogprobs(choice: unknown): TopMap | null {
  if (!choice || typeof choice !== 'object') return null;
  const logprobs = (choice as Record<string, unknown>)['logprobs'];
  if (!logprobs || typeof logprobs !== 'object') return null;
  const content = (logprobs as Record<string, unknown>)['content'];
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!first || typeof first !== 'object') return null;
  const top = (first as Record<string, unknown>)['top_logprobs'];
  const out: TopMap = new Map();
  if (Array.isArray(top)) {
    for (const item of top) {
      if (!item || typeof item !== 'object') continue;
      const token = (item as Record<string, unknown>)['token'];
      const logprob = (item as Record<string, unknown>)['logprob'];
      if (typeof token === 'string' && typeof logprob === 'number' && Number.isFinite(logprob)) {
        out.set(token.trim(), logprob);
      }
    }
  } else if (top && typeof top === 'object') {
    for (const [token, logprob] of Object.entries(top as Record<string, unknown>)) {
      if (typeof logprob === 'number' && Number.isFinite(logprob)) out.set(token.trim(), logprob);
    }
  }
  return out.size > 0 ? out : null;
}

function labelProbabilities(top: TopMap, labels: string[]): number[] {
  const floor = (top.size ? Math.min(...top.values()) : -20) - FLOOR_GAP;
  const lps = labels.map((label) => top.get(label) ?? floor);
  const max = Math.max(...lps);
  const exps = lps.map((lp) => Math.exp(lp - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

const round5 = (x: number): number => Math.round(x * 1e5) / 1e5;

function answerFor(q: JevQuestion, labels: string[], top: TopMap): Record<string, unknown> {
  const probs = labelProbabilities(top, labels);
  if (q.type === 'choice') {
    const keys = q.keys as string[];
    let best = 0;
    probs.forEach((p, i) => { if (p > probs[best]) best = i; });
    const probabilities: Record<string, number> = {};
    keys.forEach((k, i) => { probabilities[k] = round5(probs[i]); });
    return { type: 'choice', choice: keys[best], probabilities, confidence: round5(probs[best]) };
  }
  if (q.type === 'score') {
    const levels = q.levels as string[];
    const score = probs.reduce((acc, p, i) => acc + p * i, 0);
    const legend: Record<string, string> = {};
    const probabilities: Record<string, number> = {};
    levels.forEach((lvl, i) => { legend[String(i)] = lvl; probabilities[String(i)] = round5(probs[i]); });
    return { type: 'score', score: round5(score), legend, probabilities, confidence: round5(Math.max(...probs)) };
  }
  const avg = probs.reduce((acc, p, i) => acc + p * (i + 1), 0);
  const noul = Math.min(0.99, Math.max(0.01, ((avg - 1) / 8) * 0.98 + 0.01));
  return { type: 'noul', noul: round5(noul) };
}

/** True when the row points at OpenRouter, whose Jev is served natively on
 *  the Decisions API (host match covers api./www./bare openrouter.ai). */
export function isOpenRouterUpstream(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('openrouter.ai');
  } catch {
    return false;
  }
}

/** The Decisions API URL is ORIGIN-scoped (/api/alpha), independent of whether
 *  the row's base ends in /api/v1, /v1, or bare — so derive from the origin. */
export function openRouterDecisionsUrl(baseUrl: string): string {
  return new URL(baseUrl).origin + '/api/alpha/decisions';
}

/** Map OpenRouter's DecisionsResponse (camelCase usage) onto our Jev shape. */
export function mapDecisionsResponse(
  data: Record<string, unknown>,
  questionCount: number,
): Record<string, unknown> {
  const usage = (data['usage'] ?? {}) as Record<string, unknown>;
  return {
    model: data['model'],
    answers: data['answers'],
    usage: {
      input_tokens: Number(usage['inputTokens'] ?? 0),
      output_tokens: Number(usage['outputTokens'] ?? 0),
      reads: questionCount,
      ...(usage['cost'] !== undefined ? { cost: usage['cost'] } : {}),
    },
  };
}

// ── upstream resolution + read ───────────────────────────────────────────────

interface JevUpstream {
  baseUrl: string;
  headers: Record<string, string>;
  defaultModel: string;
}

/** The 'other'-category row (prefer id `open-jev`) is the Jev read upstream. */
function resolveJevUpstream(configPath: string): JevUpstream | null {
  const cfg = loadConfig(configPath);
  const others = (cfg.providers ?? []).filter((p) => p.category === 'other');
  const row = others.find((p) => p.id === 'open-jev') ?? others[0];
  if (!row) return null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const key = resolveEnvKey(row.apiKey);
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    headers,
    defaultModel: row.models?.[0] ?? 'jev-latest',
  };
}

async function readBoundary(
  upstream: JevUpstream,
  model: string,
  content: string | Array<Record<string, unknown>>,
): Promise<{ top: TopMap; usage: Record<string, unknown> }> {
  const url = `${upstream.baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content }],
    max_tokens: 1,
    temperature: 0,
    logprobs: true,
    top_logprobs: TOP_K,
  });
  let status = 0;
  let text = '';
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchUpstream(
      url,
      { method: 'POST', headers: upstream.headers, body },
      { providerId: 'byo' },
    ).catch((err: unknown) => {
      status = 0;
      text = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (response) {
      if (response.ok) {
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const choice = Array.isArray(data?.['choices']) ? data['choices'][0] : undefined;
        const top = parseTopLogprobs(choice);
        if (!top) {
          throw new JevUpstreamError(
            'upstream returned no top_logprobs — the Jev read needs an OpenAI-compatible ' +
              'chat upstream that returns logprobs',
          );
        }
        return { top, usage: (data?.['usage'] as Record<string, unknown>) ?? {} };
      }
      status = response.status;
      text = (await response.text().catch(() => '')).slice(0, 300);
      if (![429, 500, 502, 503, 504].includes(status)) break;
    }
    if (attempt >= RETRY_DELAYS_MS.length - 1) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
  throw new JevUpstreamError(`upstream chat failed (${status}): ${text}`);
}

/** Native Decisions passthrough for OpenRouter rows: forward the Jev body
 *  verbatim, return its answers untouched (only usage is normalized). */
async function readDecisionsNative(
  upstream: JevUpstream,
  model: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = openRouterDecisionsUrl(upstream.baseUrl);
  const payload = JSON.stringify({ model, state: body['state'], questions: body['questions'] });
  let status = 0;
  let text = '';
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchUpstream(
      url,
      { method: 'POST', headers: upstream.headers, body: payload },
      { providerId: 'byo' },
    ).catch((err: unknown) => {
      status = 0;
      text = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (response) {
      if (response.ok) {
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (data && data['answers'] && typeof data['answers'] === 'object') {
          return mapDecisionsResponse(data, Object.keys(body['questions'] as object).length);
        }
        throw new JevUpstreamError('upstream decisions response missing answers');
      }
      status = response.status;
      text = (await response.text().catch(() => '')).slice(0, 300);
      if (![429, 500, 502, 503, 504].includes(status)) break;
    }
    if (attempt >= RETRY_DELAYS_MS.length - 1) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
  throw new JevUpstreamError(`upstream decisions failed (${status}): ${text}`);
}

// ── gateway mount ─────────────────────────────────────────────────────────────

/** Minimal JSON helpers (local to this module — it mounts OUTSIDE adminApi). */
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function writeJsonError(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'jev_error', message } });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JevBadRequest('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Bearer 必须 hash 命中一个启用的访问密钥（与 CLI 客户端同款密钥）。 */
async function authorize(req: http.IncomingMessage, keyDb: OutboundKeyDb): Promise<boolean> {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const row = await keyDb.outboundApiKeysGetByHash(hashKey(header.slice('Bearer '.length).trim()));
  return row !== null;
}

/**
 * The listener-level mount wired into the outbound server's deps by bootstrap.
 * Owns path/method matching and its own access-key auth; returns true iff the
 * request was handled (the chat router must then not run).
 */
export function createJevSystemoneMount(deps: {
  configPath: string;
  keyDb: OutboundKeyDb;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  return async (req, res): Promise<boolean> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
    if (path !== '/v1/systemone') return false;
    if (method !== 'POST') {
      writeJsonError(res, 405, `method ${method} not allowed on /v1/systemone`);
      return true;
    }
    if (!(await authorize(req, deps.keyDb))) {
      writeJsonError(res, 401, "invalid or missing access key (Authorization: Bearer <omnicross access key>)");
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJsonError(res, 422, err instanceof Error ? err.message : String(err));
      return true;
    }
    let images: string[];
    try {
      images = extractImages(body);
    } catch (err) {
      writeJsonError(res, 422, err instanceof Error ? err.message : String(err));
      return true;
    }
    const questionsRaw = body['questions'];
    if (!questionsRaw || typeof questionsRaw !== 'object' || Array.isArray(questionsRaw)) {
      writeJsonError(res, 422, 'questions must be a non-empty object');
      return true;
    }
    const entries = Object.entries(questionsRaw as Record<string, unknown>);
    if (entries.length === 0) {
      writeJsonError(res, 422, 'questions must be a non-empty object');
      return true;
    }

    const upstream = resolveJevUpstream(deps.configPath);
    if (!upstream) {
      writeJsonError(res, 409, "no Jev upstream: add the open-jev provider (LLM Providers → Other) and fill its key");
      return true;
    }
    const requested = typeof body['model'] === 'string' && body['model'].trim() ? body['model'].trim() : '';
    const model = !requested || requested === 'jev-latest' ? upstream.defaultModel : requested;

    let normalized: Array<[string, JevQuestion]>;
    try {
      normalized = entries.map(([qid, raw]) => [qid, normalizeQuestion(qid, raw)]);
    } catch (err) {
      writeJsonError(res, 422, err instanceof Error ? err.message : String(err));
      return true;
    }

    try {
      if (isOpenRouterUpstream(upstream.baseUrl)) {
        if (images.length > 0) {
          writeJsonError(res, 422, 'images are not supported on the OpenRouter decisions path (text state only)');
          return true;
        }
        writeJson(res, 200, await readDecisionsNative(upstream, model, body));
        return true;
      }
      const results = await Promise.all(
        normalized.map(async ([, q]) => {
          const { content, labels } = buildPrompt(body['state'], q, images);
          const { top, usage } = await readBoundary(upstream, model, content);
          return { answer: answerFor(q, labels, top), usage };
        }),
      );
      const usage = {
        input_tokens: results.reduce((acc, r) => acc + Number(r.usage['prompt_tokens'] ?? 0), 0),
        output_tokens: results.reduce((acc, r) => acc + Number(r.usage['completion_tokens'] ?? 0), 0),
        reads: results.length,
      };
      const answers: Record<string, unknown> = {};
      normalized.forEach(([qid], i) => { answers[qid] = results[i].answer; });
      writeJson(res, 200, { model, answers, usage });
    } catch (err) {
      writeJsonError(res, 502, err instanceof Error ? err.message : String(err));
    }
    return true;
  };
}
