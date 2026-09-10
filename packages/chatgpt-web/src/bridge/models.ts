/**
 * models.ts — the fixed `chatgpt-web/*` model catalog served to Codex.
 *
 * Every routed row pins exactly one Codex protocol effort that maps to one
 * position on ChatGPT's effort slider: Instant(0) Medium(1) High(2) Extra
 * High(3) Pro(4). Pro uses Codex's `ultra` protocol value but binds to the
 * slider's top position at the adapter boundary. Context windows and composer
 * limits are the measured values from codex-chatgpt-web (Plus and Pro
 * browser transports), including the hidden ChatGPT platform reserve.
 *
 * @module @omnicross/chatgpt-web/bridge/models
 */

export const CHATGPT_WEB_MODEL_PREFIX = 'chatgpt-web/';

export type ChatGptWebAdapterEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ChatGptWebCodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';

/** Hidden ChatGPT product prompt + schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;

// Measured Plus browser transport windows (Instant / Medium+High).
export const CHATGPT_WEB_INSTANT_CONTEXT_WINDOW = 41_000;
export const CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32_000;
export const CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW = 90_000;
export const CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80_000;
export const CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211_256;
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 1_048_572;

// Measured Pro-account windows and one-message boundaries.
export const CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT = 95_000;
export const CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
export const CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
export const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
export const CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545_000;
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = 1_045_000;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;

// Luna-only accounts (no Sol selector) ride the Luna window.
export const CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1_050_000;

export interface ChatGptWebAccountCapabilities {
  /** The account exposes the Sol model/effort picker. */
  solAvailable: boolean;
  /** The account exposes Pro (slider spans five positions). */
  proAvailable: boolean;
}

export interface ChatGptWebModelRoute {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  adapterEffort: ChatGptWebAdapterEffort;
  /** Slider position index when the account exposes the effort slider; null for Luna routes. */
  uiEffortIndex: 0 | 1 | 2 | 3 | 4 | null;
  requiresPro: boolean;
  isLuna: boolean;
}

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  {
    slug: 'chatgpt-web/luna',
    displayName: 'ChatGPT Web — Luna',
    description: 'ChatGPT Web Luna for accounts without the Sol model selector.',
    codexEffort: 'low',
    adapterEffort: 'low',
    uiEffortIndex: null,
    requiresPro: false,
    isLuna: true,
  },
  {
    slug: 'chatgpt-web/think',
    displayName: 'ChatGPT Web — Think',
    description: 'ChatGPT Web Think for Luna-only accounts.',
    codexEffort: 'low',
    adapterEffort: 'medium',
    uiEffortIndex: null,
    requiresPro: false,
    isLuna: true,
  },
];

export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  {
    slug: 'chatgpt-web/light',
    displayName: 'ChatGPT Web — Instant',
    description: 'ChatGPT Web Instant through the native Codex harness.',
    codexEffort: 'low',
    adapterEffort: 'low',
    uiEffortIndex: 0,
    requiresPro: false,
    isLuna: false,
  },
  {
    slug: 'chatgpt-web/medium',
    displayName: 'ChatGPT Web — Medium',
    description: 'ChatGPT Web Medium through the native Codex harness.',
    codexEffort: 'medium',
    adapterEffort: 'medium',
    uiEffortIndex: 1,
    requiresPro: false,
    isLuna: false,
  },
  {
    slug: 'chatgpt-web/high',
    displayName: 'ChatGPT Web — High',
    description: 'ChatGPT Web High through the native Codex harness.',
    codexEffort: 'high',
    adapterEffort: 'high',
    uiEffortIndex: 2,
    requiresPro: false,
    isLuna: false,
  },
  {
    slug: 'chatgpt-web/extra-high',
    displayName: 'ChatGPT Web — Extra High',
    description: 'Account-gated ChatGPT Web Extra High through the native Codex harness.',
    codexEffort: 'xhigh',
    adapterEffort: 'xhigh',
    uiEffortIndex: 3,
    requiresPro: true,
    isLuna: false,
  },
  {
    slug: 'chatgpt-web/pro',
    displayName: 'ChatGPT Web — Pro',
    description: 'Account-gated ChatGPT Pro through the native Codex harness.',
    codexEffort: 'ultra',
    adapterEffort: 'max',
    uiEffortIndex: 4,
    requiresPro: true,
    isLuna: false,
  },
];

const routesBySlug = new Map(
  [...CHATGPT_WEB_LUNA_MODEL_ROUTES, ...CHATGPT_WEB_MODEL_ROUTES].map((route) => [route.slug, route]),
);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

/** Routes visible for the probed account capabilities. */
export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebModelRoute[] {
  if (!capabilities.solAvailable) return CHATGPT_WEB_LUNA_MODEL_ROUTES;
  return capabilities.proAvailable
    ? CHATGPT_WEB_MODEL_ROUTES
    : CHATGPT_WEB_MODEL_ROUTES.filter((route) => !route.requiresPro);
}

/** Resolve one route or fail explicitly with the reason. */
export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebModelRoute {
  const route = routesBySlug.get(modelId);
  if (!route) {
    throw new Error(
      `Unknown ChatGPT Web model: ${modelId}. Available: ${[
        ...availableChatGptWebModelRoutes(capabilities),
      ]
        .map((entry) => entry.slug)
        .join(', ')}`,
    );
  }
  if (route.isLuna && capabilities.solAvailable) {
    throw new Error(`${route.displayName} is only available for Luna-only accounts`);
  }
  if (!route.isLuna && !capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if (route.requiresPro && !capabilities.proAvailable) {
    throw new Error(`${route.displayName} is not available for this account (Pro not exposed)`);
  }
  return route;
}

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

/** Resolve the product context limit for one route under the probed capabilities. */
export function resolveChatGptWebContextLimits(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebContextLimits {
  const limits = (() => {
    if (route.isLuna) {
      return { contextWindow: CHATGPT_WEB_LUNA_CONTEXT_WINDOW, autoCompactTokenLimit: CHATGPT_WEB_LUNA_CONTEXT_WINDOW };
    }
    if (capabilities.proAvailable) {
      const contextWindow =
        route.adapterEffort === 'max'
          ? CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW
          : CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW;
      return { contextWindow, autoCompactTokenLimit: CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT };
    }
    if (route.adapterEffort === 'low') {
      return {
        contextWindow: CHATGPT_WEB_INSTANT_CONTEXT_WINDOW,
        autoCompactTokenLimit: CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT,
      };
    }
    return {
      contextWindow: CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW,
      autoCompactTokenLimit: CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT,
    };
  })();
  return {
    contextWindow: limits.contextWindow,
    effectiveContextWindowPercent: Math.round((limits.autoCompactTokenLimit / limits.contextWindow) * 100),
    autoCompactTokenLimit: limits.autoCompactTokenLimit,
  };
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}

/** Resolve one visible composer message's limits, independent of model context. */
export function resolveChatGptWebTransportLimits(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebTransportLimits {
  if (route.isLuna) return {};
  if (!capabilities.proAvailable) {
    if (route.adapterEffort === 'low') return { browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT };
    return { browserComposerCharLimit: CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT };
  }
  if (route.adapterEffort === 'low') {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT,
    };
  }
  if (route.adapterEffort === 'max') {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT,
  };
}

/**
 * The /v1/models payload for the routed rows. Codex's models manager decodes
 * `{"models":[…]}` (the native catalog shape), NOT the public OpenAI
 * `{"object":"list","data":[…]}` envelope — the slug/display/effort/window
 * fields mirror what codex-chatgpt-web's catalog augmentation emits.
 */
export function buildChatGptWebModelsDocument(
  capabilities: ChatGptWebAccountCapabilities,
): Record<string, unknown> {
  return {
    models: availableChatGptWebModelRoutes(capabilities).map((route) => {
      const limits = resolveChatGptWebContextLimits(route, capabilities);
      return {
        slug: route.slug,
        display_name: route.displayName,
        description: route.description,
        visibility: 'list',
        supported_in_api: true,
        tool_mode: null,
        input_modalities: ['text', 'image'],
        default_reasoning_level: route.codexEffort,
        supported_reasoning_levels: [
          { effort: route.codexEffort, description: route.displayName },
        ],
        context_window: limits.contextWindow,
        max_context_window: limits.contextWindow,
        effective_context_window_percent: limits.effectiveContextWindowPercent,
        auto_compact_token_limit: limits.autoCompactTokenLimit,
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
      };
    }),
  };
}
