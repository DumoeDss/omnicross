/**
 * commands/login.ts — `omnicross login <provider>` browser OAuth login
 * (omnicross-daemon-parity-oauth D3/D5).
 *
 * Runs the full provider OAuth flow and lands the minted token ONLY through the
 * encrypted credential store (`JsonSubscriptionCredentialStore` → `persist` →
 * `SecretBox`). Redirect form is per-provider (NOT chosen by us):
 *   - codex  → LOOPBACK: open/print the authorize URL, capture the callback on a
 *              one-shot `127.0.0.1:1455` listener (`loopbackCallback.ts`),
 *   - claude → CODE-PASTE (oob): print the URL, readline-prompt for the pasted
 *              `code` or `code#state` (split on `#` → code + state),
 *   - gemini → CODE-PASTE (oob): print the URL, readline-prompt for the oob code.
 *
 * Browser open is best-effort (`rundll32`/`open`/`xdg-open`); on failure it falls
 * back to printing the URL so a headless operator can open it manually. The
 * console NEVER prints a token — success prints only a masked confirmation
 * (`maskProviderApiKey` last-4) + `expiresAt`. OQ2 (LEAD): readline-only — no
 * `--code` two-step / sidecar (readline covers every provider's login).
 *
 * Test seam: `runLogin(argv, deps?)` accepts injectable `openBrowser` /
 * `promptPaste` / `awaitLoopback` so the command tests drive the flow with no
 * real browser, listener, or readline (the OAuth token exchange itself runs
 * through the store's injected `fetchImpl`, mocked in tests via `tokensFetch`).
 *
 * @module @omnicross/daemon/commands/login
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import type {
  ClaudeTokenConfig,
  CodexTokenConfig,
  GeminiTokenConfig,
} from '@omnicross/contracts/account-tokens-types';
import { fetchUpstream, setUpstreamProxyResolver } from '@omnicross/core/pipeline/upstreamFetch';
import { claudeOAuth, codexOAuth, type FetchLike, geminiOAuth } from '@omnicross/subscriptions';

import { maskProviderApiKey } from '../admin/adminApi';
import { setSecretBox } from '../config';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { createUpstreamProxyResolver } from '../proxy/upstreamProxyResolver';

import { awaitLoopbackCode } from './loopbackCallback';
import { defaultTokensPath, resolveSecretBox } from './paths';

/** The providers `login` understands. */
const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
type LoginProvider = (typeof PROVIDERS)[number];

/** Injectable side-effects so the command can be tested without I/O. */
export interface LoginDeps {
  /** Open the authorize URL in the OS browser; resolves `true` on launch. */
  openBrowser(url: string): Promise<boolean>;
  /** Prompt the operator to paste the callback string (claude/gemini). */
  promptPaste(prompt: string): Promise<string>;
  /** Wait for the codex loopback callback and resolve the authorization code. */
  awaitLoopback(expectedState: string): Promise<string>;
  /** HTTP port injected into the credential store for the token exchange. */
  tokensFetch?: FetchLike;
}

/** Run the `login` subcommand. `argv` is everything after `login`. */
export async function runLogin(argv: string[], deps?: Partial<LoginDeps>): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      'master-key-file': { type: 'string' },
      // Optional user label for the appended account (multi-account).
      label: { type: 'string' },
    },
    allowPositionals: true,
  });

  const provider = positionals[0];
  if (!provider) {
    throw new Error(`login: a <provider> is required (one of ${PROVIDERS.join('|')})`);
  }
  if (!isLoginProvider(provider)) {
    throw new Error(`login: unknown provider '${provider}' (expected ${PROVIDERS.join('|')})`);
  }
  if (!values.config) {
    throw new Error('login: --config <path> is required');
  }

  const resolved: LoginDeps = {
    openBrowser: deps?.openBrowser ?? openBrowser,
    promptPaste: deps?.promptPaste ?? promptPaste,
    awaitLoopback: deps?.awaitLoopback ?? ((state) => awaitLoopbackCode(state)),
    tokensFetch: deps?.tokensFetch,
  };

  // Offline encrypted store (mirrors `secrets`/`providers`): resolve the box,
  // set it for any config seam, build the store directly. `finally` clears it.
  const box = resolveSecretBox(values['master-key-file']);
  setSecretBox(box);
  // upstream-proxy: the offline login has no daemon bootstrap, so register the
  // env-layer resolver here (HTTPS_PROXY/NO_PROXY) — the common proxy-required
  // case for a login exchange. Cleared in `finally`.
  setUpstreamProxyResolver(createUpstreamProxyResolver());
  try {
    const tokensPath = defaultTokensPath(values.config);
    // Funnel the token exchange through the proxy-aware helper (providerId ctx);
    // a test-injected `tokensFetch` overrides it verbatim.
    const exchangeFetch: FetchLike =
      resolved.tokensFetch ?? ((url, init) => fetchUpstream(url, init, { providerId: provider }));
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, exchangeFetch);
    const expiresAt = await runProviderLogin(
      provider,
      store,
      resolved,
      exchangeFetch,
      values.label,
    );
    // Masked confirmation ONLY — never a token.
    console.info(`Logged in to '${provider}' → ${tokensPath}`);
    console.info(`  token: [stored, encrypted]   expiresAt: ${expiresAt ?? 'n/a'}`);
  } finally {
    setSecretBox(null);
    setUpstreamProxyResolver(null);
  }
}

/** Dispatch the per-provider authorize + exchange + store-write; return expiresAt. */
async function runProviderLogin(
  provider: LoginProvider,
  store: JsonSubscriptionCredentialStore,
  deps: LoginDeps,
  exchangeFetch: FetchLike,
  label?: string,
): Promise<string | undefined> {
  if (provider === 'codex') return loginCodex(store, deps, exchangeFetch, label);
  if (provider === 'claude') return loginClaude(store, deps, exchangeFetch, label);
  return loginGemini(store, deps, exchangeFetch, label);
}

// ── codex (loopback) ──────────────────────────────────────────────────────────

async function loginCodex(
  store: JsonSubscriptionCredentialStore,
  deps: LoginDeps,
  exchangeFetch: FetchLike,
  label?: string,
): Promise<string> {
  const { authUrl, codeVerifier, state } = codexOAuth.generateAuthParams();
  await presentUrl(authUrl, deps);
  // The loopback listener captures the code AND validates state against ours.
  const code = await deps.awaitLoopback(state);
  const result = await codexOAuth.exchangeCodeForTokens(
    { authorizationCode: code, codeVerifier, state },
    exchangeFetch,
  );
  const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
  const block: CodexTokenConfig = {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    idToken: result.idToken,
    expiresAt,
    lastRefreshedAt: new Date().toISOString(),
  };
  await store.appendProviderAccount('codex', block, label);
  logMasked('codex', result.accessToken);
  return expiresAt;
}

// ── claude (code-paste, `code#state`) ──────────────────────────────────────────

async function loginClaude(
  store: JsonSubscriptionCredentialStore,
  deps: LoginDeps,
  exchangeFetch: FetchLike,
  label?: string,
): Promise<string> {
  const { authUrl, codeVerifier, state } = claudeOAuth.generateAuthParams();
  await presentUrl(authUrl, deps);
  const pasted = (await deps.promptPaste('Paste the authorization code (code#state): ')).trim();
  // Claude's oob callback returns `code#state`; split and validate.
  const [code, pastedState] = pasted.split('#');
  if (!code) throw new Error('login: no authorization code was pasted');
  if (pastedState && pastedState !== state) {
    throw new Error('login: pasted state did not match (possible CSRF) — aborting');
  }
  const result = await claudeOAuth.exchangeCodeForTokens(
    { authorizationCode: code, codeVerifier, state },
    exchangeFetch,
  );
  const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
  const block: ClaudeTokenConfig = {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt,
    scopes: result.scopes,
    lastRefreshedAt: new Date().toISOString(),
  };
  await store.appendProviderAccount('claude', block, label);
  logMasked('claude', result.accessToken);
  return expiresAt;
}

// ── gemini (code-paste, oob) ────────────────────────────────────────────────────

async function loginGemini(
  store: JsonSubscriptionCredentialStore,
  deps: LoginDeps,
  exchangeFetch: FetchLike,
  label?: string,
): Promise<string> {
  const { authUrl, codeVerifier } = geminiOAuth.generateAuthParams();
  await presentUrl(authUrl, deps);
  const code = (await deps.promptPaste('Paste the authorization code: ')).trim();
  if (!code) throw new Error('login: no authorization code was pasted');
  const result = await geminiOAuth.exchangeCodeForTokens(code, codeVerifier, exchangeFetch);
  const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
  const block: GeminiTokenConfig = {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt,
    lastRefreshedAt: new Date().toISOString(),
  };
  await store.appendProviderAccount('gemini', block, label);
  logMasked('gemini', result.accessToken);
  return expiresAt;
}

// ── shared helpers ──────────────────────────────────────────────────────────

function isLoginProvider(value: string): value is LoginProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Open the URL in a browser; ALWAYS print it too (it carries no token). */
async function presentUrl(authUrl: string, deps: LoginDeps): Promise<void> {
  console.info('Open this URL in your browser to authorize:');
  console.info(`  ${authUrl}`);
  const launched = await deps.openBrowser(authUrl).catch(() => false);
  if (!launched) {
    console.info('(Could not open a browser automatically — open the URL above manually.)');
  }
}

/** Masked success line — last-4 only, NEVER the full token. */
function logMasked(provider: string, accessToken: string): void {
  console.info(`  ${provider} access token: ${maskProviderApiKey(accessToken)}`);
}

/**
 * Build the platform browser-open `[command, args]` (pure — unit-testable).
 *
 * win32 uses `rundll32 url.dll,FileProtocolHandler <url>` — the canonical Windows
 * "open in the default handler" entry point. We DELIBERATELY avoid `cmd /c start`:
 * `cmd.exe` parses `&` (and other metacharacters, which authorize URLs are full
 * of — every provider's URL has multiple `&`-separated params) BEFORE `start`
 * runs, so `start "" <url>` truncates the URL at the first `&` and spawns failed
 * sub-commands. `rundll32` never goes through a shell: Node passes the URL as a
 * single literal argv element straight to CreateProcess, so no `&`/quote parsing
 * happens at all (the URL is fixed-config + crypto-random state, not attacker-
 * controlled — this is a correctness fix, not injection hardening). mac/linux
 * `open` / `xdg-open` already take the URL as one literal argv element.
 */
export function buildOpenBrowserCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Spawn the platform browser opener; resolve `false` on any failure. */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { command, args } = buildOpenBrowserCommand(process.platform, url);
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      // Give the spawn a tick to surface an immediate failure, else assume launched.
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/** Prompt the operator for a pasted value via `node:readline`. */
function promptPaste(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
