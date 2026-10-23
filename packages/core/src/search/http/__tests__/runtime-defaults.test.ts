import { SearchProviderError } from '@omnicross/contracts/search-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSearchRuntime } from '../../runtime';
import { HttpBingProvider } from '../HttpBingProvider';
import { HttpDuckDuckGoProvider } from '../HttpDuckDuckGoProvider';
import { HttpEcosiaProvider } from '../HttpEcosiaProvider';
import { HttpMojeekProvider } from '../HttpMojeekProvider';
import { HttpPublicSearchProvider } from '../HttpPublicSearchProvider';
import { HttpStartpageProvider } from '../HttpStartpageProvider';

afterEach(() => { vi.restoreAllMocks(); });

describe('default runtime HTTP opt-in boundary', () => {
  it.each([false, true])('does not contact new engines after original engines fail (preferred-only: %s)', async (preferNew) => {
    const error = new SearchProviderError('upstream_unavailable', 'engine unavailable');
    const bing = vi.spyOn(HttpBingProvider.prototype, 'search').mockRejectedValue(error);
    const duckduckgo = vi.spyOn(HttpDuckDuckGoProvider.prototype, 'search').mockRejectedValue(error);
    const result = [{ title: 'Source', url: 'https://source.example/', content: 'Snippet' }];
    const startpage = vi.spyOn(HttpStartpageProvider.prototype, 'search').mockResolvedValue(result);
    const ecosia = vi.spyOn(HttpEcosiaProvider.prototype, 'search').mockResolvedValue(result);
    const mojeek = vi.spyOn(HttpMojeekProvider.prototype, 'search').mockResolvedValue(result);
    const publicSearch = vi.spyOn(HttpPublicSearchProvider.prototype, 'search').mockResolvedValue(result);
    const runtime = createSearchRuntime(preferNew ? { policy: { preferred: 'http-startpage' } } : {});

    await expect(runtime.search({ query: 'example' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(bing).toHaveBeenCalledTimes(1);
    expect(duckduckgo).toHaveBeenCalledTimes(1);
    expect(startpage).not.toHaveBeenCalled();
    expect(ecosia).not.toHaveBeenCalled();
    expect(mojeek).not.toHaveBeenCalled();
    expect(publicSearch).not.toHaveBeenCalled();
  });

  it('permits a new engine when the caller explicitly allows it in policy', async () => {
    const startpage = vi.spyOn(HttpStartpageProvider.prototype, 'search').mockResolvedValue([
      { title: 'Source', url: 'https://source.example/', content: 'Snippet' },
    ]);
    const runtime = createSearchRuntime({ policy: { allowed: ['http-startpage'] } });
    const response = await runtime.search({ query: 'example' });
    expect(response.providerId).toBe('http-startpage');
    expect(response.results[0].url).toBe('https://source.example/');
    expect(startpage).toHaveBeenCalledTimes(1);
  });
});
