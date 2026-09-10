// One-shot page-state probe (single tab): URL, title, composer, iframes, body text.
import { CdpConnection } from '../packages/chatgpt-web/src/cdp/connection';
import { CHATGPT_TEMPORARY_CHAT_URL } from '../packages/chatgpt-web/src/chatgpt/selectors';

const conn = new CdpConnection({});
const hardExit = setTimeout(() => process.exit(2), 60_000);
try {
  await conn.ensureConnected();
  const tab = await conn.openTab('about:blank');
  await tab.navigate(CHATGPT_TEMPORARY_CHAT_URL, 30_000);
  await new Promise((r) => setTimeout(r, 6_000));
  const state = await tab.evaluateJson<Record<string, unknown>>(`(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    composerCount: document.querySelectorAll('[data-testid="prompt-textarea"],#prompt-textarea').length,
    iframes: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 90)),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
  }))()`);
  console.log(JSON.stringify(state, null, 1));
  await tab.close();
} catch (error) {
  console.error('PROBE ERROR:', error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(hardExit);
  conn.close();
  process.exit(0);
}
