/**
 * DeepSeek DSML tool-call salvage.
 *
 * DeepSeek's models carry tool calls as **DSML** (DeepSeek Markup Language) — an
 * XML-ish block the model writes as TEXT, which DeepSeek's own conversion layer
 * (`deepseek-ai/deepseek-recipe`) is supposed to parse back into structured
 * `tool_calls` before the response leaves the API. When that parse is skipped or
 * fails, the raw block is delivered as ordinary assistant prose:
 *
 *     <｜DSML｜ calls>
 *     <｜DSML｜ invoke name="functions__exec">
 *     <｜DSML｜ parameter name="input" string="true">const a = 1;</｜DSML｜ parameter>
 *     </｜DSML｜ invoke>
 *     </｜DSML｜ calls>
 *
 * The turn then ends with `finish_reason: "stop"` and `tool_calls: null`, so an
 * agent loop sees a plain final answer and stops dead — no tool ever runs, and
 * the user watches the model "type out" its own tool syntax as prose.
 *
 * This module recognizes the block and rebuilds the calls the model meant to
 * make, so the response chain can hand codex a real `function_call` /
 * `custom_tool_call` item instead of a wall of markup.
 *
 * ## What the markup actually looks like
 *
 * The delimiter is **U+FF5C FULLWIDTH VERTICAL LINE** (bytes `EF BD 9C`), not
 * ASCII `|` — a regex written with a plain pipe never matches. Everything else
 * varies by model version, and every variant below has been seen in the wild:
 *
 * | variant        | example opener                    |
 * | -------------- | --------------------------------- |
 * | V4             | `<｜DSML｜tool_calls>`              |
 * | V4.1 (default) | `<｜DSML｜ calls>`  (leading space) |
 * | V3.2           | `<｜DSML｜function_calls>`          |
 * | bare invoke    | `<｜DSML｜invoke name="x">`         |
 * | doubled pipes  | `<｜｜DSML｜｜ calls>`              |
 * | ASCII pipes    | `<|DSML| calls>` (web proxies)    |
 *
 * Closers carry the marker too (`</｜DSML｜ parameter>`), which is why parsers
 * expecting a bare `</parameter>` miss them; a missing closer is also common and
 * must not lose the call.
 *
 * ## Scope guard
 *
 * Only a line-anchored opener counts, and openers inside ``` fences are
 * ignored: an assistant explaining DSML, or writing `List<int>` / `if (a < b)`,
 * must never be turned into an executable tool call.
 *
 * @module transformer/transformers/utils/dsmlToolCalls
 */

/**
 * A DSML marker prefix — `<` or `</`, then a run of 1-3 vertical bars (U+FF5C or
 * ASCII `|`), `DSML`, the bar run again, and whatever inline spacing the
 * renderer left before the tag name.
 *
 * Stripping this turns the block into plain `<invoke name="…">` / `</parameter>`
 * tags, so one normal pass parses every markup variant above.
 */
const DSML_MARKER_PREFIX = /<(\/?)[｜|]{1,3}[ \t]*DSML[｜|]{1,3}[ \t]*/g;

/** A line that opens a DSML block/invoke while still carrying its marker. */
const DSML_OPENER_MARKED =
  /^[ \t]*<[｜|]{1,3}[ \t]*DSML[｜|]{1,3}[ \t]*(calls|tool_calls|function_calls|invoke)\b/;

/** Closing tags of the block wrappers, used to bound the last invoke. */
const BLOCK_CLOSE_TAGS = ['</calls', '</tool_calls', '</function_calls'] as const;

/**
 * One recovered call, in the shape the chat wire uses: `name` is the FLATTENED
 * declaration name the model saw (e.g. `functions__exec`) and `arguments` is a
 * JSON string the existing encoder unwraps — including the `{input:…}` envelope
 * a codex `custom` tool needs.
 */
export interface DsmlSalvagedCall {
  name: string;
  arguments: string;
}

export interface DsmlSalvageResult {
  /** Calls the model meant to make — empty when the block held none. */
  calls: DsmlSalvagedCall[];
  /** `text` with the DSML block (and everything after it) removed. */
  cleaned: string;
  /** True when the text carried DSML markup at all. */
  sawMarkup: boolean;
}

/** Case-insensitive `indexOf` for a tag, so closers can bound a value scan. */
function indexOfTag(text: string, tag: string, from: number): number {
  return text.toLowerCase().indexOf(tag, from);
}

/**
 * Index where the DSML block starts, or -1. Fence-aware and line-anchored:
 * markup quoted inside a ``` example is prose, not a call.
 */
function findMarkupStart(text: string): number {
  if (!text.includes('DSML')) return -1;
  let offset = 0;
  let fence = '';
  for (const line of text.split('\n')) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    } else if (!fence && DSML_OPENER_MARKED.test(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return -1;
}

/** True when `text` carries a DSML block that should be salvaged or stripped. */
export function hasDsmlMarkup(text: string): boolean {
  return findMarkupStart(text) !== -1;
}

/** `text` with the DSML block removed — for the no-call and no-tools paths. */
export function stripDsmlMarkup(text: string): string {
  const start = findMarkupStart(text);
  return start === -1 ? text : text.slice(0, start).trimEnd();
}

/**
 * A `string="true"` value, kept verbatim apart from the newlines the renderer
 * wrapped around it. Never `.trim()`: leading/trailing SPACES can be the payload
 * (a shell fragment, a file body), and silently eating them corrupts the call.
 */
function stringParamValue(raw: string): string {
  return raw.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
}

/** A `string="false"` value: JSON, falling back to the raw text when malformed. */
function jsonParamValue(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return stringParamValue(raw);
  }
}

/**
 * Parameters of one invoke body → an arguments object.
 *
 * Each value runs to its own `</parameter>` — or, when the model forgot the
 * closer, to the NEXT parameter / the end of the invoke. Bounding by the next
 * opener matters: otherwise one unclosed parameter swallows every later one.
 */
function parseInvokeParameters(body: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const openRe =
    /<parameter\s+name\s*=\s*["']([^"']+)["'](?:\s+string\s*=\s*["'](true|false)["'])?[^>]*>/gi;
  const opens = [...body.matchAll(openRe)];

  for (let i = 0; i < opens.length; i++) {
    const match = opens[i];
    const valueStart = (match.index ?? 0) + match[0].length;
    const nextOpen = opens[i + 1]?.index ?? -1;
    const close = indexOfTag(body, '</parameter', valueStart);
    const valueEnd =
      close !== -1 && (nextOpen === -1 || close < nextOpen)
        ? close
        : nextOpen === -1
          ? body.length
          : nextOpen;

    const raw = body.slice(valueStart, valueEnd);
    // Absent `string=` reads as true: the spec only omits it for strings.
    params[match[1]] =
      (match[2] ?? 'true').toLowerCase() === 'false' ? jsonParamValue(raw) : stringParamValue(raw);
  }

  return params;
}

/**
 * Recover the tool calls a DSML block encodes, plus the prose that surrounded
 * them.
 *
 * A malformed invoke is skipped rather than aborting the scan — losing one call
 * beats losing the turn — and `cleaned` drops the protocol block on every path
 * so markup can never reach the user even when nothing parses.
 */
export function salvageDsmlToolCalls(text: string): DsmlSalvageResult {
  const start = findMarkupStart(text);
  if (start === -1) return { calls: [], cleaned: text, sawMarkup: false };

  const cleaned = text.slice(0, start).trimEnd();
  const normalized = text.slice(start).replace(DSML_MARKER_PREFIX, '<$1');

  const invokeRe = /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const opens = [...normalized.matchAll(invokeRe)];
  const calls: DsmlSalvagedCall[] = [];

  for (let i = 0; i < opens.length; i++) {
    const match = opens[i];
    const name = match[1];
    if (!name) continue;

    const bodyStart = (match.index ?? 0) + match[0].length;
    // The invoke body ends at whichever comes first: the next invoke, its own
    // closer, the block's closer, or the end of the text.
    const limits = [
      opens[i + 1]?.index ?? -1,
      indexOfTag(normalized, '</invoke', bodyStart),
      ...BLOCK_CLOSE_TAGS.map((tag) => indexOfTag(normalized, tag, bodyStart)),
    ].filter((limit) => limit !== -1);
    const bodyEnd = limits.length ? Math.min(...limits) : normalized.length;

    calls.push({
      name,
      arguments: JSON.stringify(parseInvokeParameters(normalized.slice(bodyStart, bodyEnd))),
    });
  }

  return { calls, cleaned, sawMarkup: true };
}

/**
 * A deterministic call id for a salvaged call.
 *
 * Deterministic on purpose: codex matches a tool result back to its call by id,
 * and a retry of the same turn that produced a fresh random id would orphan the
 * output of a tool that already ran. FNV-1a over name+arguments+position is
 * stable across processes and attempts.
 */
export function dsmlCallId(call: DsmlSalvagedCall, index: number): string {
  let hash = 0x811c9dc5;
  const seed = `${call.name}\u0000${call.arguments}\u0000${index}`;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `call_dsml_${hash.toString(16).padStart(8, '0')}`;
}

// ============================================================================
// Streaming suppression
// ============================================================================

/**
 * Holds back DSML markup on a live SSE stream.
 *
 * Text is emitted incrementally, but only up to the last complete line: the
 * marker always starts its own line, so a `\n` boundary can never split one. As
 * soon as a completed line turns out to be a DSML opener, the rest of the stream
 * is captured instead of emitted, and `flush()` hands it to the salvage parser
 * at end-of-turn.
 *
 * A fixed-size tail buffer (the usual shortcut) is both wrong and unnecessary
 * here: the opening line can be long, and a partial marker emitted as prose can
 * never be taken back.
 */
export class DsmlStreamSuppressor {
  private pending = '';
  private captured: string | null = null;
  private fence = '';
  private releasedLine = false;

  get capturing(): boolean { return this.captured !== null; }
  get capturedText(): string { return this.captured ?? ''; }

  push(delta: string): string {
    if (this.captured !== null) {
      this.captured += delta;
      return '';
    }
    this.pending += delta;
    let prose = '';
    while (true) {
      if (!this.releasedLine && !this.fence && DSML_OPENER_MARKED.test(this.pending)) {
        this.captured = this.pending;
        this.pending = '';
        return prose;
      }
      const newline = this.pending.indexOf('\n');
      if (newline === -1) break;
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      const marker = !this.releasedLine ? /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1] : undefined;
      if (marker) {
        if (!this.fence) this.fence = marker;
        else if (marker[0] === this.fence[0] && marker.length >= this.fence.length) this.fence = '';
      }
      prose += line;
      this.releasedLine = false;
    }
    // Only a potential line-start marker/fence needs buffering. Remember that
    // a released prefix belongs to the same line across future push calls.
    const prefix = this.pending.trimStart();
    const markerPrefix = prefix === '<' || /^<\/?[｜|]/.test(prefix);
    if (this.releasedLine || (prefix && !markerPrefix && !prefix.startsWith('`') && !prefix.startsWith('~')) || this.pending.length > 4096) {
      prose += this.pending;
      this.releasedLine = this.releasedLine || this.pending.length > 0;
      this.pending = '';
    }
    return prose;
  }

  flush(): string {
    if (this.captured !== null) return '';
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}


// ============================================================================
// Kill switch
// ============================================================================

/**
 * Environment switch. DeepSeek is expected to fix the conversion-layer parse on
 * their side; when they do, this salvage should be turned off rather than
 * deleted, and the response chain goes back to a byte-for-byte relay.
 *
 *   unset (default) | 1 | true | on   → salvage DeepSeek upstreams
 *   0 | false | off | no              → salvage off entirely
 *   all | force | any                 → salvage EVERY upstream
 *
 * `all` is the escape hatch for a DeepSeek-compatible relay whose provider name
 * happens to not read as DeepSeek — the leak is diagnosed by the warning below,
 * and one env var applies the fix without a code change.
 */
export const DSML_SALVAGE_ENV = 'OMNICROSS_DEEPSEEK_DSML_SALVAGE';

export type DsmlSalvageMode = 'off' | 'deepseek' | 'all';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const ALL_VALUES = new Set(['all', 'force', 'any']);

/** Matches the models that emit DSML — the only upstreams this salvage targets. */
const DEEPSEEK_MODEL = /deepseek/i;

let salvageOverride: DsmlSalvageMode | undefined;

/** Which upstreams the salvage applies to, per `DSML_SALVAGE_ENV`. */
export function dsmlSalvageMode(): DsmlSalvageMode {
  if (salvageOverride !== undefined) return salvageOverride;
  const raw = process.env?.[DSML_SALVAGE_ENV]?.trim().toLowerCase();
  if (!raw) return 'deepseek';
  if (OFF_VALUES.has(raw)) return 'off';
  if (ALL_VALUES.has(raw)) return 'all';
  return 'deepseek';
}

/** True unless the salvage is switched off entirely. */
export function isDsmlSalvageEnabled(): boolean {
  return dsmlSalvageMode() !== 'off';
}

/**
 * Force the mode for this process, overriding the environment. Tests use it;
 * `undefined` hands control back to `DSML_SALVAGE_ENV`.
 */
export function setDsmlSalvageMode(mode: DsmlSalvageMode | undefined): void {
  salvageOverride = mode;
}

/** True when a model/provider name belongs to the DeepSeek family. */
export function isDeepseekName(value: unknown): boolean {
  return typeof value === 'string' && DEEPSEEK_MODEL.test(value);
}

/**
 * True when the salvage should run for this response.
 *
 * `responseModel` counts too: it is the upstream's OWN name for what answered,
 * and it survives the upstream mapping that may have rewritten the request
 * model into something that no longer reads as DeepSeek.
 */
export function isDsmlSalvageArmed(
  requestModel?: unknown,
  providerName?: unknown,
  responseModel?: unknown,
): boolean {
  const mode = dsmlSalvageMode();
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return (
    isDeepseekName(requestModel) || isDeepseekName(providerName) || isDeepseekName(responseModel)
  );
}

let warnedUnarmed = false;

/**
 * Note — once — that DSML markup was seen on an upstream the salvage is not
 * armed for. Without this the failure mode is invisible: the model IS leaking
 * markup and the fix silently did not apply because no name read as DeepSeek.
 * Names only; no message content is ever logged.
 */
export function warnDsmlUnarmed(responseModel: unknown): void {
  if (warnedUnarmed) return;
  warnedUnarmed = true;
  console.warn(
    `[transform] DeepSeek DSML tool-call markup arrived from an upstream the salvage does not ` +
      `target (response model '${String(responseModel)}'). Tool calls will NOT be recovered. ` +
      `Set ${DSML_SALVAGE_ENV}=all to apply the salvage to every upstream.`,
  );
}
