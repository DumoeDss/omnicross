/**
 * html-to-markdown + snapshot-script + effort parsing tests (DOM-free where
 * possible; jsdom for the converter).
 *
 * @module @omnicross/chatgpt-web/__tests__/conversion.test
 */

import { describe, expect, it } from 'vitest';

import { chatGptHtmlToMarkdown } from '../chatgpt/html-to-markdown';
import { parseChatGptEffortSliderState } from '../chatgpt/effort';
import {
  composerTextScript,
  insertPlainTextIntoComposerScript,
} from '../chatgpt/snapshot';

describe('chatGptHtmlToMarkdown', () => {
  it('converts headings, lists, and fenced code', () => {
    const html = [
      '<h2>Title</h2>',
      '<ul><li>one</li><li>two</li></ul>',
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    ].join('');
    const markdown = chatGptHtmlToMarkdown(html);
    expect(markdown).toContain('## Title');
    expect(markdown).toContain('- one');
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('const x = 1;');
  });

  it('renders GFM tables', () => {
    const html =
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    expect(chatGptHtmlToMarkdown(html)).toContain('| a | b |');
  });

  it('drops buttons, images, and svg chrome', () => {
    const html = '<p>text</p><button>Copy</button><img src="x.png" alt="chart"><svg><path/></svg>';
    const markdown = chatGptHtmlToMarkdown(html);
    expect(markdown).toContain('text');
    expect(markdown).not.toContain('Copy');
    expect(markdown).not.toContain('chart');
    expect(markdown).not.toContain('svg');
  });

  it('links bare inline file paths', () => {
    const markdown = chatGptHtmlToMarkdown('<p>see <code>src/index.ts</code> for details</p>');
    expect(markdown).toContain('[src/index.ts](<src/index.ts>)');
  });

  it('returns empty for empty input', () => {
    expect(chatGptHtmlToMarkdown('   ')).toBe('');
  });
});

describe('parseChatGptEffortSliderState', () => {
  it('accepts a five-position range (Pro)', () => {
    expect(parseChatGptEffortSliderState(0, 4, 2)).toEqual({ min: 0, max: 4, value: 2 });
  });

  it('accepts a four-position range (Plus without Pro)', () => {
    expect(parseChatGptEffortSliderState(0, 3, 3)).toEqual({ min: 0, max: 3, value: 3 });
  });

  it('rejects ranges beyond five options and out-of-range values', () => {
    expect(parseChatGptEffortSliderState(0, 5, 2)).toBeUndefined();
    expect(parseChatGptEffortSliderState(0, 4, 9)).toBeUndefined();
    expect(parseChatGptEffortSliderState(NaN, 4, 2)).toBeUndefined();
  });
});

describe('in-page scripts', () => {
  it('injects the prompt value safely into the insert script', () => {
    const script = insertPlainTextIntoComposerScript('line1\n"quoted" </script>');
    // The value rides a JSON string literal (newline escaped), never raw
    // concatenation into the expression source.
    expect(script).toContain('line1\\n');
    expect(script).toContain('\\"quoted\\" </script>');
    expect(script).toMatch(/const value = "/);
  });

  it('composerTextScript is a self-contained expression', () => {
    const script = composerTextScript();
    expect(script.startsWith('(() => {')).toBe(true);
    expect(script.trim().endsWith('})()')).toBe(true);
  });
});
