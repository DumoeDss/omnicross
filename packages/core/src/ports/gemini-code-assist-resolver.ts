/**
 * GeminiCodeAssistResolver port.
 *
 * The OpenAI Responses ingress (gemini subscription path) resolves the Gemini
 * Code Assist project id for a gemini subscription account. The concrete
 * resolver (`GeminiCodeAssistProjectResolver`) is HOST-CLEAN and lives in the
 * serving core itself (`@omnicross/core/auth/GeminiCodeAssistProjectResolver`):
 * it imports only the core Gemini transformer helpers, `fetch`, and
 * `process.env` — it couples to NO host token/OAuth service.
 *
 * Even so, the ingress reads it through this narrow port + module-level
 * injection slot rather than importing the impl directly, so each embedder wires
 * the same shared resolver at bootstrap (e.g. via
 * `setGeminiCodeAssistResolver(getGeminiCodeAssistProjectResolver())`). An
 * unwired slot resolves `undefined` (the valid free-tier no-project case).
 */

/** Narrow structural port for the Gemini Code Assist project resolver. */
export interface GeminiCodeAssistResolverPort {
  resolveProject(accessToken: string): Promise<string | undefined>;
}

let resolver: GeminiCodeAssistResolverPort | null = null;

/** Each embedder wires the concrete (core-resident) resolver at bootstrap. */
export function setGeminiCodeAssistResolver(impl: GeminiCodeAssistResolverPort | null): void {
  resolver = impl;
}

/** The ingress reads the injected resolver (null until an embedder wires it). */
export function getGeminiCodeAssistResolver(): GeminiCodeAssistResolverPort | null {
  return resolver;
}
