const CODEX_BEGIN = '# >>> omnicross managed provider >>>';
const CODEX_END = '# <<< omnicross managed provider <<<';
const CODEX_PROVIDER = 'omnicross';
/** Root key an external tool may set to pin Codex to a static model catalog
 *  file; while our integration owns routing it suppresses the runtime
 *  discovery our `model_catalog_url` rides, so the install comments it out. */
const CODEX_EXTERNAL_CATALOG_KEY = 'model_catalog_json';
/** Marker suffix on the commented-out line — what restore matches to undo. */
const CODEX_EXTERNAL_CATALOG_DISABLED_MARKER = '# disabled by Omnicross';
/** An UNMARKED provider table (e.g. hand-written following the README's
 *  manual-setup snippet) — adopted, not rejected, by renderCodexConfig. */
const UNMANAGED_PROVIDER_TABLE = /^\s*\[\s*model_providers\s*\.\s*["']?omnicross["']?\s*(\.[^\]]*)?\s*]/;
/**
 * Non-empty dummy for `ANTHROPIC_API_KEY`: an empty/absent value lets Claude
 * Code fall back to its OAuth login state, so the install (and key-scoped
 * terminal launches) pin this sentinel to force the AUTH_TOKEN path.
 */
export const CLAUDE_API_KEY_SENTINEL = 'omnicross-gateway';

export interface CodexConfigInput {
  existing: string;
  gatewayBaseUrl: string;
  gatewayModelDiscovery?: boolean;
  authHelper: {
    command: string;
    args: string[];
  };
}

/**
 * Lossless outside the two managed regions; uninstall restores the exact snapshot.
 *
 * A pre-existing UNMARKED `[model_providers.omnicross]` table (e.g. written by
 * hand following the README's manual-setup snippet) is ADOPTED, not rejected:
 * the table plus its dotted sub-tables is stripped from the base and superseded
 * by the managed block below. The pre-install snapshot `install()` persists
 * keeps the original bytes, so `remove()` still restores them exactly.
 */
export function renderCodexConfig(input: CodexConfigInput): string {
  if (input.existing.includes(CODEX_BEGIN) || input.existing.includes(CODEX_END)) {
    throw new Error(
      'Codex config.toml has a leftover/incomplete Omnicross marker. '
      + 'Delete the lines between (and including) "# >>> omnicross managed provider >>>" '
      + 'and "# <<< omnicross managed provider <<<", then retry.',
    );
  }

  const eol = input.existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = stripUnmanagedProviderTables(input.existing.replace(/\r\n/g, '\n').split('\n'));
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
  const rootEnd = firstTable < 0 ? lines.length : firstTable;
  const assignments: Record<'model_provider', number[]> = {
    model_provider: [],
  };
  for (let index = 0; index < rootEnd; index += 1) {
    if (/^\s*#/.test(lines[index])) continue;
    for (const key of Object.keys(assignments) as Array<keyof typeof assignments>) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) assignments[key].push(index);
    }
  }
  if (assignments.model_provider.length > 1) {
    throw new Error('Codex config has duplicate top-level model_provider keys');
  }
  const managedRoot: Record<keyof typeof assignments, string> = {
    model_provider: `model_provider = "${CODEX_PROVIDER}" # managed by Omnicross`,
  };
  const missing: string[] = [];
  for (const key of Object.keys(assignments) as Array<keyof typeof assignments>) {
    const [index] = assignments[key];
    if (index === undefined) missing.push(managedRoot[key]);
    else lines[index] = managedRoot[key];
  }
  if (missing.length > 0) lines.splice(rootEnd, 0, ...missing, '');

  // model-name-visibility: an ACTIVE root `model_catalog_json` (another tool's
  // static catalog) makes Codex ignore our runtime model-list discovery — the
  // picker would stay locked to that tool's models whatever our toggle says.
  // Comment it out IN PLACE (lossless: the assignment text survives verbatim
  // inside the comment); restoreCodexBase un-comments it on remove/repair.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line) || !new RegExp(`^\\s*${CODEX_EXTERNAL_CATALOG_KEY}\\s*=`).test(line)) continue;
    lines[index] =
      `# ${line.trim()} ${CODEX_EXTERNAL_CATALOG_DISABLED_MARKER} ` +
      '(runtime model-list discovery is active while the Omnicross integration is installed)';
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const base = lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
  const root = trimTrailingSlash(input.gatewayBaseUrl);
  const block = [
    CODEX_BEGIN,
    `[model_providers.${CODEX_PROVIDER}]`,
    'name = "Omnicross Local Gateway"',
    `base_url = ${tomlString(`${root}/v1`)}`,
    ...(input.gatewayModelDiscovery
      ? [`model_catalog_url = ${tomlString(`${root}/v1/codex-model-catalog`)}`]
      : []),
    'wire_api = "responses"',
    'supports_websockets = false',
    'http_headers = { "X-OpenAI-Actor-Authorization" = "omnicross" }',
    '',
    `[model_providers.${CODEX_PROVIDER}.auth]`,
    `command = ${tomlString(input.authHelper.command)}`,
    `args = ${tomlString(input.authHelper.args)}`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 0',
    CODEX_END,
    '',
  ].join('\n');
  return (base + block).replace(/\n/g, eol);
}

/**
 * Remove every `[model_providers.omnicross…]` table header AND its body —
 * from the header line through the line before the next table header of the
 * same or an unrelated name. Blank lines left behind collapse away.
 */
function stripUnmanagedProviderTables(lines: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const isTableHeader = /^\s*\[/.test(line) && !/^\s*#/.test(line);
    if (skipping) {
      // A header inside the skip: another omnicross sub-table keeps the skip
      // alive; any unrelated table ends it (and is kept).
      if (!isTableHeader) continue;
      if (UNMANAGED_PROVIDER_TABLE.test(line)) continue;
      skipping = false;
    } else if (isTableHeader && UNMANAGED_PROVIDER_TABLE.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Env key for Claude Code's LLM-gateway model-list discovery (see
 *  code.claude.com/docs/en/model-config — populates the picker from the
 *  gateway's `/v1/models`). Only injected while `modelNaming.realNames` is on:
 *  with it off, Claude Code keeps its stock picker untouched. */
const CLAUDE_GATEWAY_MODEL_DISCOVERY_ENV = 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';

export function renderClaudeSettings(
  existing: string,
  gatewayBaseUrl: string,
  secret: string,
  /** model-name-visibility: enable Claude Code's gateway model discovery. */
  gatewayModelDiscovery = false,
): string {
  let parsed: unknown = {};
  if (existing.trim()) {
    try { parsed = JSON.parse(existing) as unknown; }
    catch { throw new Error('Claude settings file is not valid JSON'); }
  }
  if (!isPlainObject(parsed)) throw new Error('Claude settings root must be a JSON object');
  const settings = { ...parsed } as Record<string, unknown>;
  const oldEnv = settings.env;
  if (oldEnv !== undefined && !isPlainObject(oldEnv)) {
    throw new Error('Claude settings env field must be a JSON object');
  }
  settings.env = {
    ...(oldEnv as Record<string, unknown> | undefined),
    ANTHROPIC_BASE_URL: trimTrailingSlash(gatewayBaseUrl),
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: CLAUDE_API_KEY_SENTINEL,
    ...(gatewayModelDiscovery ? { [CLAUDE_GATEWAY_MODEL_DISCOVERY_ENV]: '1' } : {}),
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

export function hasCodexRuntimeDiscovery(existing: string): boolean {
  const start = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END, start);
  if (start < 0 || end < 0) return false;
  return /^\s*model_catalog_url\s*=/m.test(existing.slice(start, end));
}

/**
 * True when the config's ROOT carries an EXTERNAL `model_catalog_json`
 * assignment (another tool's static catalog). Codex then routes ALL model-list
 * behavior through that file and IGNORES per-provider runtime discovery — our
 * managed `model_catalog_url` fetch never run, so the picker stays locked to
 * the other tool's models regardless of `modelNaming.realNames`. DETECTION
 * ONLY: Omnicross never writes or removes the key (it is not ours to manage);
 * plan + status surface the conflict for the user to resolve.
 */
export function hasExternalModelCatalog(existing: string): boolean {
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
  const rootEnd = firstTable < 0 ? lines.length : firstTable;
  // A commented-out assignment (`# model_catalog_json = ...`) is not active.
  return lines
    .slice(0, rootEnd)
    .some((line) => /^\s*model_catalog_json\s*=/.test(line) && !/^\s*#/.test(line));
}

/** Remove our Codex block and restore only the pre-install root selectors. */
export function restoreCodexBase(current: string, original: string): string {
  const hasBegin = current.includes(CODEX_BEGIN);
  const hasEnd = current.includes(CODEX_END);
  if (hasBegin !== hasEnd) throw new Error('Codex config has an incomplete Omnicross managed block');
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  let normalized = current.replace(/\r\n/g, '\n');
  if (hasBegin) {
    const start = normalized.indexOf(CODEX_BEGIN);
    const endMarker = normalized.indexOf(CODEX_END, start);
    if (endMarker < 0) throw new Error('Codex config has an incomplete Omnicross managed block');
    const end = normalized.indexOf('\n', endMarker);
    normalized = normalized.slice(0, start) + (end < 0 ? '' : normalized.slice(end + 1));
  }

  const lines = normalized.split('\n');
  // `preferred_auth_method` remains in this list only to restore installations
  // created by the legacy auth.json adapter. New installs never manage it.
  for (const key of ['model_provider', 'preferred_auth_method'] as const) {
    const originalAssignment = rootAssignment(original, key);
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
    const rootEnd = firstTable < 0 ? lines.length : firstTable;
    const managedIndex = lines.slice(0, rootEnd).findIndex(
      (line) => new RegExp(`^\\s*${key}\\s*=.*#\\s*managed by Omnicross\\s*$`).test(line),
    );
    if (managedIndex >= 0) {
      if (originalAssignment) lines[managedIndex] = originalAssignment;
      else lines.splice(managedIndex, lines[managedIndex + 1] === '' ? 2 : 1);
    }
  }
  // model-name-visibility: put the external static catalog back exactly as the
  // pre-install snapshot had it. The disabled line only exists when the
  // original carried the key, so restore verbatim (delete as a safety net).
  {
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
    const rootEnd = firstTable < 0 ? lines.length : firstTable;
    const disabledIndex = lines.slice(0, rootEnd).findIndex((line) =>
      new RegExp(
        `^\\s*#\\s*${CODEX_EXTERNAL_CATALOG_KEY}\\s*=.*${CODEX_EXTERNAL_CATALOG_DISABLED_MARKER}`,
      ).test(line),
    );
    if (disabledIndex >= 0) {
      const originalAssignment = rootAssignment(original, CODEX_EXTERNAL_CATALOG_KEY);
      if (originalAssignment) lines[disabledIndex] = originalAssignment;
      else lines.splice(disabledIndex, 1);
    }
  }
  return lines.join('\n').replace(/\n/g, eol);
}

/** Restore only Claude env values still equal to the values Omnicross installed. */
export function restoreClaudeBase(
  current: string,
  original: string,
  gatewayBaseUrl: string,
  secret: string,
): string {
  const currentRoot = parseSettings(current);
  const originalRoot = parseSettings(original);
  const env = isPlainObject(currentRoot.env) ? { ...currentRoot.env } : {};
  const originalEnv = isPlainObject(originalRoot.env) ? originalRoot.env : {};
  const expected: Record<string, string> = {
    ANTHROPIC_BASE_URL: trimTrailingSlash(gatewayBaseUrl),
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: CLAUDE_API_KEY_SENTINEL,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) continue;
    if (Object.prototype.hasOwnProperty.call(originalEnv, key)) env[key] = originalEnv[key];
    else delete env[key];
  }
  // The discovery flag is a fixed sentinel (not secret-derived): restore it the
  // same way when it still carries our injected value and the original had none.
  if (
    env[CLAUDE_GATEWAY_MODEL_DISCOVERY_ENV] === '1' &&
    !Object.prototype.hasOwnProperty.call(originalEnv, CLAUDE_GATEWAY_MODEL_DISCOVERY_ENV)
  ) {
    delete env[CLAUDE_GATEWAY_MODEL_DISCOVERY_ENV];
  }
  const next = { ...currentRoot };
  if (Object.keys(env).length > 0 || Object.prototype.hasOwnProperty.call(originalRoot, 'env')) next.env = env;
  else delete next.env;
  return JSON.stringify(next, null, 2) + '\n';
}

export function containsPlaintextGatewayKey(content: string): boolean {
  return content.includes('sk-omnicross-');
}

function tomlString(value: string | string[]): string {
  return JSON.stringify(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSettings(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error('Claude settings file is not valid JSON'); }
  if (!isPlainObject(parsed)) throw new Error('Claude settings root must be a JSON object');
  return parsed;
}

function rootAssignment(content: string, key: string): string | undefined {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
  const root = lines.slice(0, firstTable < 0 ? lines.length : firstTable);
  return root.find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line) && !/^\s*#/.test(line));
}
