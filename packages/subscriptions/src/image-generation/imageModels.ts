/** Model IDs understood by the Codex image adapter. Availability is account-dependent. */
export const CODEX_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export type CodexImageModel = (typeof CODEX_IMAGE_MODELS)[number];

export function isCodexImageModel(value: unknown): value is CodexImageModel {
  return typeof value === 'string' && (CODEX_IMAGE_MODELS as readonly string[]).includes(value);
}
