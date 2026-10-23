import { describe, expect, it } from 'vitest';

import { SEARCH_RESPONSE_BYTES } from '../engine';
import { extendedHttpSearchContributions } from '../extendedContributions';
import { HttpEcosiaProvider } from '../HttpEcosiaProvider';
import { HttpMojeekProvider } from '../HttpMojeekProvider';
import { HttpStartpageProvider } from '../HttpStartpageProvider';
import type { SearchHttpRequest, SearchHttpTransport } from '../types';

// Synthetic HTML models the documented organic boundaries, not captured network pages.
const cases = [
  {
    label: 'Startpage',
    factory: (transport: SearchHttpTransport) => new HttpStartpageProvider(transport),
    row: (title: string, url: string, content = 'A &amp; B') =>
      `<div class="result"><a class="result-link" href="${url}"><h2>${title}</h2></a><p class="description">${content}</p></div>`,
    ad: '<div class="a-bg-result"><a class="result-link" href="https://ads.example/"><h2>Ad</h2></a></div>',
    shell: '<main id="results"><div class="result"></div></main>',
    ownUrl: 'https://other.startpage.com/navigation',
    endpoint: 'https://www.startpage.com/sp/search',
    queryParam: 'query',
  },
  {
    label: 'Ecosia',
    factory: (transport: SearchHttpTransport) => new HttpEcosiaProvider(transport),
    row: (title: string, url: string, content = 'A &amp; B') =>
      `<article data-test-id="organic-result"><a href="${url}"><h2 data-test-id="result-title">${title}</h2></a><div data-test-id="result-description"><span>Thumbnail caption</span><p data-test-id="web-result-description">${content}</p></div></article>`,
    ad: '<article data-test-id="ad-google"><a href="https://ads.example/"><h2 data-test-id="result-title">Ad</h2></a></article>',
    shell: '<main><article data-test-id="organic-result"></article></main>',
    ownUrl: 'https://other.ecosia.org/navigation',
    endpoint: 'https://www.ecosia.org/search',
    queryParam: 'q',
  },
  {
    label: 'Mojeek',
    factory: (transport: SearchHttpTransport) => new HttpMojeekProvider(transport),
    row: (title: string, url: string, content = 'A &amp; B') =>
      `<ul class="results-standard"><li class="clu-result"><h2><a class="title" href="${url}">${title}</a></h2><p class="s">${content}</p></li></ul>`,
    ad: '<ul class="results-sponsored"><li><h2><a class="title" href="https://ads.example/">Ad</a></h2></li></ul>',
    shell: '<ul class="results-standard"><li>No entries</li></ul>',
    ownUrl: 'https://other.mojeek.co.uk/navigation',
    endpoint: 'https://www.mojeek.de/search',
    queryParam: 'q',
  },
];

function serving(html: string, finalUrl?: string): SearchHttpTransport {
  return async (url) => ({
    finalUrl: finalUrl ?? url,
    rawText: html,
    status: 200,
    contentType: 'text/html',
  });
}

for (const fixture of cases) {
  describe(`${fixture.label} HTTP organic boundaries`, () => {
    it('extracts only valid organic rows, decodes text, deduplicates and caps', async () => {
      const html = fixture.ad +
        '<h2><a href="https://unscoped.example/">Not an organic result</a></h2>' +
        fixture.row(' One &amp; two ', 'https://source.example/first#fragment') +
        fixture.row('Duplicate', 'https://source.example/first#other') +
        fixture.row('Invalid', 'javascript:alert(1)') +
        fixture.row('Invalid', 'data:text/plain,hello') +
        fixture.row('Credential target', 'https://user:secret@source.example/private') +
        fixture.row('Internal', fixture.ownUrl) +
        fixture.row('Relative', '/settings') +
        fixture.row('N/A', 'https://source.example/not-a-title') +
        fixture.row('', 'https://source.example/empty-title') +
        fixture.row('Second', 'https://source.example/second') +
        fixture.row('Third', 'https://source.example/third');
      expect(await fixture.factory(serving(html)).search('example', { maxResults: 2 })).toEqual([
        { title: 'One & two', url: 'https://source.example/first', content: 'A & B' },
        { title: 'Second', url: 'https://source.example/second', content: 'A & B' },
      ]);
    });

    it('enforces every hard domain exclusion locally before applying maxResults', async () => {
      const html =
        fixture.row('Blocked parent', 'https://blocked.example/first') +
        fixture.row('Blocked subdomain', 'https://sub.blocked.example/second') +
        fixture.row('Other blocked domain', 'https://other.example/third') +
        fixture.row('Allowed similar suffix', 'https://notblocked.example/fourth') +
        fixture.row('Allowed source', 'https://source.example/fifth');
      expect(await fixture.factory(serving(html)).search(
        'example -site:blocked.example -site:other.example', { maxResults: 1 },
      )).toEqual([
        { title: 'Allowed similar suffix', url: 'https://notblocked.example/fourth', content: 'A & B' },
      ]);
    });

    it('never relaxes exclusions when every otherwise valid row is excluded', async () => {
      const html = fixture.row('Blocked source', 'https://sub.blocked.example/first');
      expect(await fixture.factory(serving(html)).search('example -site:blocked.example')).toEqual([]);
    });

    it('fails closed for empty shells and invalid-only pages rather than returning success', async () => {
      for (const html of [fixture.shell, fixture.ad, '<h2><a href="https://source.example/">Generic heading</a></h2>', fixture.row('Internal', fixture.ownUrl)]) {
        await expect(fixture.factory(serving(html)).search('example')).rejects.toMatchObject({
          code: 'parse_failed',
          details: { stage: 'parse' },
        });
      }
    });

    it('uses the shared response/deadline bounds and does not claim unsupported query filters', async () => {
      const attempts: { url: URL; request: SearchHttpRequest }[] = [];
      const provider = fixture.factory(async (url, request) => {
        attempts.push({ url: new URL(url), request });
        return { finalUrl: url, rawText: fixture.row('Source', 'https://source.example/'), status: 200, contentType: 'text/html' };
      });
      const controller = new AbortController();
      await provider.search('a & b / 中文', {
        maxResults: 1,
        timeout: 400,
        signal: controller.signal,
        language: 'fr',
        region: 'fr',
        timeRange: 'day',
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].url.origin + attempts[0].url.pathname).toBe(fixture.endpoint);
      expect(attempts[0].url.searchParams.get(fixture.queryParam)).toBe('a & b / 中文');
      expect(attempts[0].url.searchParams.has('since')).toBe(false);
      expect(attempts[0].url.searchParams.has('with_date')).toBe(false);
      expect(attempts[0].request.maxResponseBytes).toBe(SEARCH_RESPONSE_BYTES);
      expect(attempts[0].request.timeoutMs).toBeGreaterThan(0);
      expect(attempts[0].request.timeoutMs).toBeLessThanOrEqual(400);
      expect(attempts[0].request.signal).toBe(controller.signal);
    });

    it('does not confuse ordinary CAPTCHA/security snippets with a challenge', async () => {
      const content = 'CAPTCHA, automated queries, Ecosia Firewall and _cf_chl_opt = are security topics';
      const results = await fixture.factory(serving(fixture.row('CAPTCHA documentation', 'https://source.example/', content))).search('captcha');
      expect(results[0].content).toBe(content);
    });

    it('rejects caller cancellation before issuing an HTTP request', async () => {
      let calls = 0;
      const provider = fixture.factory(async () => {
        calls++;
        throw new Error('must not request');
      });
      await expect(provider.search('example', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
      expect(calls).toBe(0);
    });
  });
}

it('rejects Startpage CAPTCHA redirects and Gatsby CAPTCHA components', async () => {
  const row = cases[0].row('Decoy', 'https://source.example/');
  for (const [html, finalUrl] of [
    [row, 'https://www.startpage.com/en/errors/'],
    [row, 'https://www.startpage.com/sp/captcha'],
    ['<script>window.pages = ["component---src-pages-captcha"]</script>' + row, 'https://www.startpage.com/sp/search'],
  ]) {
    await expect(new HttpStartpageProvider(serving(html, finalUrl)).search('example')).rejects.toMatchObject({
      code: 'upstream_unavailable', details: { stage: 'trust' },
    });
  }
});

it('rejects Ecosia Cloudflare challenges even if decoy organic rows are present', async () => {
  for (const challenge of [
    '<title>Ecosia Firewall</title>',
    '<script>window._cf_chl_opt = {}</script>',
    '<script src="/cdn-cgi/challenge-platform/bootstrap.js"></script>',
  ]) {
    await expect(new HttpEcosiaProvider(serving(challenge + cases[1].row('Decoy', 'https://source.example/'))).search('example')).rejects.toMatchObject({
      code: 'upstream_unavailable', details: { stage: 'trust' },
    });
  }
});

it('refuses Mojeek ALTCHA and automated-query walls without trying to solve them', async () => {
  for (const challenge of [
    '<altcha-widget challengeurl="/challenge"></altcha-widget>',
    '<div class="captcha-wrap"></div>',
    '<title>Sending automated queries</title>',
  ]) {
    await expect(new HttpMojeekProvider(serving(challenge + cases[2].row('Decoy', 'https://source.example/'))).search('example')).rejects.toMatchObject({
      code: 'upstream_unavailable', details: { stage: 'trust' },
    });
  }
});

it('does not follow title anchors enclosing an organic row from outside', async () => {
  const html = '<a href="https://unrelated.example/"><article data-test-id="organic-result"><h2 data-test-id="result-title">Wrong ancestor</h2></article></a>';
  await expect(new HttpEcosiaProvider(serving(html)).search('example')).rejects.toMatchObject({ code: 'parse_failed' });
});

it('supports Ecosia description-container fallback when no inner preview paragraph exists', async () => {
  const html = '<article data-test-id="organic-result"><a href="https://source.example/"><h2 data-test-id="result-title">Source</h2></a><div data-test-id="result-description">Fallback snippet</div></article>';
  expect(await new HttpEcosiaProvider(serving(html)).search('example')).toEqual([
    { title: 'Source', url: 'https://source.example/', content: 'Fallback snippet' },
  ]);
});

it('keeps the extended aggregate inert without an explicit host child allow-list', async () => {
  const contributions = extendedHttpSearchContributions(serving('<html></html>'));
  const aggregate = contributions.find((entry) => entry.id === 'public');
  expect(aggregate).toBeDefined();
  await expect(aggregate!.provider.search('example')).rejects.toMatchObject({ code: 'config_missing' });
});
