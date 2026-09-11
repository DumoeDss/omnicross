/**
 * selectors.ts — the ChatGPT web DOM contract this bridge depends on.
 *
 * Port of codex-chatgpt-web's chatgpt-session.ts selector constants. When
 * ChatGPT ships DOM changes, these fail explicitly rather than silently
 * degrading.
 *
 * @module @omnicross/chatgpt-web/chatgpt/selectors
 */

export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_TEMPORARY_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';

/**
 * A plain (non-temporary) conversation. Harness turns need this: temporary
 * chat hides connectors from the attach UI (its unpersonalized mode), while a
 * plain conversation lists them in the composer "+" menu.
 */
export const CHATGPT_PLAIN_CHAT_URL = 'https://chatgpt.com/';

export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(', ');

export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
].join(', ');

export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(', ');

export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;

export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
export const CHATGPT_SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';

export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(', ');

export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(', ');

export const CHATGPT_TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';

/** ChatGPT's dedicated composer upload input (verified in the reference impl). */
export const CHATGPT_FILE_INPUT_SELECTOR = 'input[data-testid="upload-photos-input"]';
