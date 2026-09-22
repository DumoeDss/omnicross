import { OpenAIOperationError } from '../../openai-operation';

/** Append `/compact` to an already-resolved Responses create URL without losing its prefix/query. */
export function deriveResponsesCompactUrl(createUrl: string): string {
  let url: URL;
  try {
    url = new URL(createUrl);
  } catch {
    throw new OpenAIOperationError({
      status: 502,
      code: 'invalid_upstream_url',
      message: 'Resolved Responses upstream URL is invalid',
    });
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/responses')) {
    throw new OpenAIOperationError({
      status: 502,
      code: 'invalid_upstream_url',
      message: 'Resolved upstream URL is not a Responses create endpoint',
    });
  }
  url.pathname = `${path}/compact`;
  return url.toString();
}

/** Codex SearchClient appends `alpha/search` to the same provider base as Responses. */
export function deriveCodexSearchUrl(createUrl: string): string {
  // Reuse validation, including base-prefix and provider query preservation.
  const url = new URL(deriveResponsesCompactUrl(createUrl));
  url.pathname = url.pathname.replace(/\/responses\/compact$/, '/alpha/search');
  return url.toString();
}
