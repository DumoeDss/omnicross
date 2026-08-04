const CODEX_BEGIN = '# >>> omnicross managed provider >>>';
const CODEX_END = '# <<< omnicross managed provider <<<';
const CODEX_PROVIDER = 'omnicross';
const CLAUDE_API_KEY_SENTINEL = 'omnicross-gateway';

export interface CodexConfigInput {
  existing: string;
  gatewayBaseUrl: string;
  helperCommand: string;
  helperArgs: string[];
}

/** Lossless outside the two managed regions; uninstall restores the exact snapshot. */
export function renderCodexConfig(input: CodexConfigInput): string {
  if (input.existing.includes(CODEX_BEGIN) || input.existing.includes(CODEX_END)) {
    throw new Error('Codex config contains an unmanaged/orphaned Omnicross marker');
  }
  if (/^\s*\[\s*model_providers\s*\.\s*["']?omnicross["']?\s*]/m.test(input.existing)) {
    throw new Error("Codex config already defines model_providers.omnicross");
  }

  const eol = input.existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = input.existing.replace(/\r\n/g, '\n').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
  const rootEnd = firstTable < 0 ? lines.length : firstTable;
  const assignments: number[] = [];
  for (let index = 0; index < rootEnd; index += 1) {
    if (/^\s*model_provider\s*=/.test(lines[index]) && !/^\s*#/.test(lines[index])) {
      assignments.push(index);
    }
  }
  if (assignments.length > 1) throw new Error('Codex config has duplicate top-level model_provider keys');
  const managedRoot = `model_provider = "${CODEX_PROVIDER}" # managed by Omnicross`;
  if (assignments.length === 1) lines[assignments[0]] = managedRoot;
  else lines.splice(rootEnd, 0, managedRoot, '');

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const base = lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
  const root = trimTrailingSlash(input.gatewayBaseUrl);
  const args = input.helperArgs.map(tomlString).join(', ');
  const block = [
    CODEX_BEGIN,
    `[model_providers.${CODEX_PROVIDER}]`,
    'name = "Omnicross Local Gateway"',
    `base_url = ${tomlString(`${root}/v1`)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
    `[model_providers.${CODEX_PROVIDER}.auth]`,
    `command = ${tomlString(input.helperCommand)}`,
    `args = [${args}]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 300000',
    CODEX_END,
    '',
  ].join('\n');
  return (base + block).replace(/\n/g, eol);
}

export function renderClaudeSettings(existing: string, gatewayBaseUrl: string, secret: string): string {
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
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Remove our Codex block and restore only the pre-install root selector. */
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

  const originalSelector = rootAssignment(original, 'model_provider');
  const lines = normalized.split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line) && !/^\s*#/.test(line));
  const rootEnd = firstTable < 0 ? lines.length : firstTable;
  const managedIndex = lines.slice(0, rootEnd)
    .findIndex((line) => /^\s*model_provider\s*=\s*["']omnicross["']\s*#\s*managed by Omnicross\s*$/.test(line));
  if (managedIndex >= 0) {
    if (originalSelector) lines[managedIndex] = originalSelector;
    else lines.splice(managedIndex, 1);
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
  const next = { ...currentRoot };
  if (Object.keys(env).length > 0 || Object.prototype.hasOwnProperty.call(originalRoot, 'env')) next.env = env;
  else delete next.env;
  return JSON.stringify(next, null, 2) + '\n';
}

export function containsPlaintextGatewayKey(content: string): boolean {
  return content.includes('sk-omnicross-');
}

function tomlString(value: string): string {
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
