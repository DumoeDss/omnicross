/**
 * Process Supervisor module — singleton accessor and re-exports.
 *
 * @module index
 */

import { createProcessSupervisor } from './supervisor';
import type { ProcessSupervisor } from './types';

let instance: ProcessSupervisor | null = null;

export function getProcessSupervisor(): ProcessSupervisor {
  if (!instance) instance = createProcessSupervisor();
  return instance;
}

export type { ChildAdapterHandle } from './child-adapter';
export type { PtyAdapterHandle } from './pty-adapter';
export type {
  ManagedRun,
  ManagedRunStdin,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  RunRegistry,
  RunState,
  SpawnChildInput,
  SpawnInput,
  SpawnPtyInput,
  TerminationReason,
} from './types';

// ── CLI proxy-env launch-config builders (chat-completions / gemini / Codex) ──
export type { ClaudeCliLaunchConfigInputs } from './proxy-env/claude-proxy-env';
export {
  buildClaudeCliLaunchConfig,
  CLAUDE_PROXY_API_KEY_SENTINEL,
} from './proxy-env/claude-proxy-env';
export type {
  ChatCliBackendId,
  ChatCliLaunchConfig,
  ChatCliLaunchConfigInputs,
  GeminiCliLaunchConfigInputs,
} from './proxy-env/cli-proxy-env';
export {
  buildChatCliLaunchConfig,
  buildGeminiCliLaunchConfig,
  CHAT_PROXY_BASE_PATH,
  OPENCODE_PROXY_PROVIDER_ID,
  OPENCODE_PROXY_TOKEN_ENV,
} from './proxy-env/cli-proxy-env';
export type {
  CodexLaunchConfig,
  CodexLaunchConfigInputs,
} from './proxy-env/codex-proxy-env';
export {
  buildCodexConfigOverrides,
  buildCodexLaunchConfig,
  CODEX_PROXY_BASE_PATH,
  CODEX_PROXY_PROVIDER_NAME,
} from './proxy-env/codex-proxy-env';
