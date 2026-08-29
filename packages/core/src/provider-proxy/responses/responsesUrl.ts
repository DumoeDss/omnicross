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
