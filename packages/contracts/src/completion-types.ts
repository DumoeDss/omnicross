/**
 * Completion API Types — public barrel.
 *
 * These types support both OpenAI chat/completions API and conversion
 * to/from Anthropic Messages API (Claude Code format).
 *
 * Source is split across `completion-types/` sub-modules. Import sites use
 * `@omnicross/contracts/completion-types`; this barrel preserves the
 * external (type) surface and is intentionally TYPE-ONLY — it does NOT
 * re-export any thinking-config runtime value (import those directly from
 * `@omnicross/contracts/thinking-config`), keeping the thinking-config closure
 * out of this barrel.
 *
 * Sub-files:
 *   - completion-types/thinking.ts     — ThinkLevel / ThinkingContent / ReasoningConfig
 *   - completion-types/openai.ts       — OpenAI chat-completions wire types
 *   - completion-types/anthropic.ts    — Anthropic Messages wire types + ConversionConfig
 *   - completion-types/simple-chat.ts  — SimpleChat (UI) types
 */

export * from './completion-types/anthropic';
export * from './completion-types/openai';
export * from './completion-types/simple-chat';
export * from './completion-types/thinking';
