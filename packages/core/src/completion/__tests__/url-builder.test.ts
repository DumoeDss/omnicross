import { describe, expect, it } from 'vitest';
import { buildAnthropicApiUrl, buildAzureOpenAIApiUrl, buildGeminiApiUrl, buildOpenAIApiUrl, buildOpenAIResponseApiUrl } from '../url-builder';

describe('provider URL routing', () => {
  it.each([
    ['chat', buildOpenAIApiUrl, 'chat/completions'],
    ['anthropic', buildAnthropicApiUrl, 'messages'],
    ['responses', buildOpenAIResponseApiUrl, 'responses'],
  ] as const)('%s keeps gateway prefix/version/query and recognizes a full endpoint', (_name, build, endpoint) => {
    for (const path of ['/proxy/v4', `/proxy/v4/${endpoint}/`]) {
      const url = new URL(build(`https://example.invalid${path}?tenant=team-a`));
      expect(url.pathname).toBe(`/proxy/v4/${endpoint}`);
      expect(url.searchParams.get('tenant')).toBe('team-a');
    }
    expect(new URL(build('https://example.invalid/proxy?tenant=team-a')).pathname).toBe(`/proxy/v1/${endpoint}`);
  });

  it.each(['/v1beta', '/v1beta/models', '/v1beta/models/', '/v1beta/models/old-model:generateContent'])('Gemini resolves a new model/action from %s without duplicating models', (path) => {
    const stream = new URL(buildGeminiApiUrl(`https://example.invalid${path}?tenant=team-a`, 'models/gemini-2.5-flash', true));
    expect(stream.pathname).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    expect(stream.searchParams.get('alt')).toBe('sse');
    expect(stream.searchParams.get('tenant')).toBe('team-a');
    const buffered = new URL(buildGeminiApiUrl(stream.toString(), 'gemini-2.5-pro', false));
    expect(buffered.pathname).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(buffered.searchParams.has('alt')).toBe(false);
    expect(buffered.searchParams.get('tenant')).toBe('team-a');
  });

  it.each(['/proxy', '/proxy/openai', '/proxy/openai/v1', '/proxy/openai/deployments/old/chat/completions'])('Azure resolves deployment/version from %s while retaining gateway query', (path) => {
    const url = new URL(buildAzureOpenAIApiUrl(`https://example.invalid${path}?tenant=team-a&api-version=old`, 'current', '2024-08-01-preview'));
    expect(url.pathname).toBe('/proxy/openai/deployments/current/chat/completions');
    expect(url.searchParams.get('tenant')).toBe('team-a');
    expect(url.searchParams.getAll('api-version')).toEqual(['2024-08-01-preview']);
  });
});
