/**
 * @omnicross/chatgpt-web — EXPERIMENTAL ChatGPT Web bridge for Codex.
 *
 * Serves `chatgpt-web/*` models (Instant…Pro / Luna) as an OpenAI Responses
 * endpoint on loopback, driving the user's own Chrome over CDP. Pure
 * composition surface: see `bridge/server` (startChatGptWebBridge) and
 * `chatgpt/session` (inspectChatGptSession).
 *
 * @module @omnicross/chatgpt-web
 */

export {
  CHATGPT_WEB_MODEL_PREFIX,
  CHATGPT_WEB_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  availableChatGptWebModelRoutes,
  buildChatGptWebModelsDocument,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  type ChatGptWebAccountCapabilities,
  type ChatGptWebModelRoute,
} from './bridge/models';
export { parseRequest } from './bridge/parser';
export { compileChatGptWebPrompt } from './bridge/prompt';
export { startChatGptWebBridge, generateBridgeToken, type ChatGptWebBridgeServerOptions, type RunningBridge } from './bridge/server';
export { inspectChatGptSession, type ChatGptSessionInspection } from './chatgpt/session';
export { CdpConnection, CdpConnectionError, CHROME_DEBUG_SETUP_GUIDANCE } from './cdp/connection';
