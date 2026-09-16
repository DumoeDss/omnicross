/**
 * html-to-markdown.ts — convert ChatGPT assistant HTML to Markdown (Node side).
 *
 * Turndown (GFM) over a jsdom fragment, with ChatGPT-specific rules: media and
 * embedded widget chrome are removed, bare inline file paths become file
 * links, and list items keep compact indentation. Mirrors codex-chatgpt-web's
 * markdown.ts conversion layer (which runs the same turndown configuration).
 *
 * @module @omnicross/chatgpt-web/chatgpt/html-to-markdown
 */

/// <reference path="../types/untyped-modules.d.ts" />

import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

turndown.use(gfm);
turndown.remove(['button', 'script', 'style']);
turndown.addRule('removeImages', {
  filter: (node) => ['IMG', 'PICTURE', 'SOURCE'].includes(node.nodeName),
  replacement: () => '',
});
turndown.addRule('removeSvg', {
  filter: (node) => node.nodeName === 'SVG',
  replacement: () => '',
});
turndown.addRule('linkInlineFilePaths', {
  filter: (node) => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent ?? '';
    return `[${path}](<${path.replaceAll('\\', '/')}>)`;
  },
});
turndown.addRule('compactListItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === 'OL') {
      const start = Number(parent.getAttribute('start') ?? '1');
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, '')
      .replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? '\n' : ''}`;
  },
});

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== 'CODE') return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (['A', 'PRE'].includes(ancestor.nodeName)) return undefined;
  }
  const path = node.textContent ?? '';
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;
  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, '');
  const separator = Math.max(withoutLocation.lastIndexOf('/'), withoutLocation.lastIndexOf('\\'));
  if (separator < 0) return undefined;
  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

/** Turndown escapes literal brackets; Codex reads `\[` as LaTeX, so restore `[[wiki links]]`. */
function preserveObsidianWikiLinks(markdown: string): string {
  return markdown.replace(/\\\[\\\[([^\r\n]*?)\\\]\\\]/g, '[[$1]]');
}

export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(`<body>${html}</body>`, { virtualConsole });
  const converted = turndown.turndown(dom.window.document.body);
  dom.window.close();
  return preserveObsidianWikiLinks(converted).trim();
}
