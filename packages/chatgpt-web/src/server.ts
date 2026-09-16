/**
 * server.ts — public subpath re-export of the Responses bridge server.
 *
 * `@omnicross/chatgpt-web/server` resolves here (tsup entry `server`), keeping
 * the daemon's dynamic import stable while the implementation lives under
 * `bridge/`.
 *
 * @module @omnicross/chatgpt-web/server
 */

export {
  startChatGptWebBridge,
  generateBridgeToken,
  type ChatGptWebBridgeServerOptions,
  type RunningBridge,
} from './bridge/server';
export { ChatGptWebBridgeWorker, MAX_CHATGPT_BROWSER_TABS } from './bridge/worker';
