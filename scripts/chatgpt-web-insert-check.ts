/**
 * chatgpt-web-insert-check.ts — single-attempt composer-insert verification.
 *
 * Manual diagnostic: compiles a realistic Codex-sized prompt through the
 * production parser+compiler, opens ONE temporary-chat tab, inserts the text,
 * verifies the readback (single shot + the production chunked fallback), and
 * reports a precise diff on mismatch. NEVER sends a message. One browser tab,
 * one attempt — on failure it stops and prints diagnostics instead of
 * retrying.
 *
 * Usage: npx tsx scripts/chatgpt-web-insert-check.ts [--size kb]
 */
import { CdpConnection } from '../packages/chatgpt-web/src/cdp/connection';
import { parseRequest } from '../packages/chatgpt-web/src/bridge/parser';
import { compileChatGptWebPrompt } from '../packages/chatgpt-web/src/bridge/prompt';
import { CHATGPT_WEB_MODEL_ROUTES } from '../packages/chatgpt-web/src/bridge/models';
import {
  composerTextScript,
  insertAndVerifyComposerScript,
} from '../packages/chatgpt-web/src/chatgpt/snapshot';
import { CHATGPT_COMPOSER_SELECTOR, CHATGPT_TEMPORARY_CHAT_URL } from '../packages/chatgpt-web/src/chatgpt/selectors';

const sizeArg = process.argv.find((arg) => arg.startsWith('--size='));
const targetInstructionsKb = sizeArg ? Number.parseInt(sizeArg.slice('--size='.length), 10) : 3;

// A realistic Codex-shaped request: multi-KB instructions with markdown
// fences, environment context XML, and a user turn.
const instructions = Array.from({ length: targetInstructionsKb }, (_, index) =>
  [
    `## Section ${index + 1}`,
    '',
    'You are a coding agent. Follow the workspace policies below.',
    '',
    'Example tool call:',
    '```json',
    JSON.stringify({ tool: 'shell', command: ['git', 'status'], id: `call_${index}` }),
    '```',
    '',
    '- Policy bullet one with <xml-ish> content.',
    '- Policy bullet two; note the special chars: "quotes" & back\\slash.',
    '',
  ].join('\n'),
).join('\n');

const body = {
  model: 'chatgpt-web/light',
  stream: true,
  instructions,
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            '<environment_context>',
            'Working directory: E:\\repo\\demo',
            'Is directory a git repo: Yes',
            'Platform: win32',
            '</environment_context>',
            '',
            'Summarize the workspace policies above in one sentence.',
          ].join('\n'),
        },
      ],
    },
  ],
};

const parsed = parseRequest(body);
const route = CHATGPT_WEB_MODEL_ROUTES.find((entry) => entry.slug === 'chatgpt-web/light')!;
const prompt = compileChatGptWebPrompt(parsed, route);
console.log(`compiled prompt: ${prompt.text.length} chars (${targetInstructionsKb}KB instructions)`);

const conn = new CdpConnection({});
const hardExit = setTimeout(() => {
  console.error('INSERT-CHECK TIMEOUT');
  process.exit(2);
}, 120_000);

try {
  await conn.ensureConnected();
  console.log('connected:', conn.describeEndpoint());
  const tab = await conn.openTab('about:blank');
  await tab.navigate(CHATGPT_TEMPORARY_CHAT_URL, 45_000);
  await tab.bringToFront();
  const ready = await tab.waitForExpression(
    `(() => { const els = document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}); ` +
      'return [...els].some(el => el.offsetParent !== null || el.getClientRects().length > 0); })()',
    45_000,
    250,
  );
  if (!ready) throw new Error('composer never appeared (login or verification gate?)');

  // Single-shot insert + in-page polled readback (exactly the production path).
  const result = await tab.evaluateJson<{ inserted: boolean; matches: boolean; length: number }>(
    insertAndVerifyComposerScript(prompt.text),
    { awaitPromise: true },
  );
  console.log(`single-shot: inserted=${result?.inserted} matches=${result?.matches} readbackChars=${result?.length}`);
  if (result?.inserted === true && result.matches === true) {
    console.log('INSERT CHECK: PASS');
  } else {
    const readback = (await tab.evaluateJson<string | null>(composerTextScript())) ?? '';
    const expected = prompt.text;
    let divergence = 0;
    while (divergence < Math.min(readback.length, expected.length)
      && readback[divergence] === expected[divergence]) {
      divergence += 1;
    }
    console.log(`DIFF: expected=${expected.length} actual=${readback.length} commonPrefix=${divergence}`);
    console.log(`expected @${divergence}: ${JSON.stringify(expected.slice(Math.max(0, divergence - 40), divergence + 80))}`);
    console.log(`actual   @${divergence}: ${JSON.stringify(readback.slice(Math.max(0, divergence - 40), divergence + 80))}`);
    console.log('expected tail:', JSON.stringify(expected.slice(-60)));
    console.log('actual   tail:', JSON.stringify(readback.slice(-60)));
    process.exitCode = 1;
  }
  await tab.close();
} catch (error) {
  console.error('INSERT-CHECK ERROR:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(hardExit);
  conn.close();
}
