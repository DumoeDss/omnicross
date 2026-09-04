/**
 * The Bing anti-decoy check's matching semantics.
 *
 * The committed decoy fixture must keep being refused, and the
 * separator-free canonical form must keep REAL pages that spell a query term
 * with inner punctuation ("Node.js" vs "nodejs") from being refused as decoys.
 *
 * @module search/http/__tests__/trust.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bingTrustError, meaningfulQueryTerms } from '../trust';

const FIXTURES = fileURLToPath(new URL('../../../../test-fixtures/http-search', import.meta.url));

function fixture(relativePath: string): string {
  return readFileSync(`${FIXTURES}/${relativePath}`, 'utf8');
}

/** A minimal but structurally honest Bing SERP with the given organic hit. */
function serp(hit: { title: string; href: string; caption?: string }): string {
  return `
    <html><body><ol id="b_results">
      <li class="b_algo">
        <h2><a href="${hit.href}">${hit.title}</a></h2>
        <div class="b_caption"><p>${hit.caption ?? ''}</p></div>
      </li>
    </ol></body></html>`;
}

describe('separator-free matching', () => {
  it('accepts a real SERP whose titles punctuate the query term', () => {
    // The live false refusal this canonical form exists for: the query spells
    // it "nodejs", every real title spells it "Node.js", and the Han bigrams
    // sit in the caption rather than the titles.
    const page = serp({
      title: 'Node.js 中文文档',
      href: 'https://nodejs.org/zh-cn/docs',
      caption: '读取文件内容的官方指南',
    });
    expect(bingTrustError('nodejs 文件读取', page)).toBeNull();
  });

  it('matches punctuated spellings in titles and hrefs alike', () => {
    const page = serp({
      title: 'GLM-4 发布',
      href: 'https://example.test/glm-4',
    });
    expect(bingTrustError('glm4 发布', page)).toBeNull();
  });

  it('still refuses a page whose titles answer a different query', () => {
    const page = serp({
      title: '下载 Firefox，这里有简体中文版本',
      href: 'https://www.mozilla.org/zh-CN/firefox/',
      caption: 'Mozilla 基金会出品',
    });
    // Zero query-term hits in the titles, no second covered term anywhere —
    // the decoy signature, punctuation notwithstanding.
    expect(bingTrustError('nodejs 文件读取', page)).toContain('zero query-term hits');
  });
});

describe('the committed decoy fixture', () => {
  it('stays refused — canonicalization must not weaken the decoy defense', () => {
    const html = fixture('bing/bing-serp-untrusted-decoy.html');
    expect(bingTrustError('hypertext transfer protocol', html)).toContain('zero query-term hits');
  });
});

describe('meaningfulQueryTerms', () => {
  it('splits on punctuation and expands Han terms into bigrams', () => {
    expect(meaningfulQueryTerms('Node.js 文件读取')).toEqual([
      'node',
      'js',
      '文件读取',
      '文件',
      '件读',
      '读取',
    ]);
  });
});
