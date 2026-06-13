// check-i18n.mjs — validate every locale JSON; report lines with unbalanced
// unescaped double quotes (the usual hand-edit corruption).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/i18n', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let failed = false;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const text = readFileSync(join(dir, f), 'utf8');
  try {
    JSON.parse(text);
  } catch (e) {
    failed = true;
    console.log(`${f}: ${e.message}`);
    text.split('\n').forEach((ln, i) => {
      let count = 0;
      for (let j = 0; j < ln.length; j++) {
        if (ln[j] === '"' && ln[j - 1] !== '\\') count++;
      }
      if (count % 2 !== 0) console.log(`  ${f}:${i + 1} odd quotes → ${ln.trim().slice(0, 110)}`);
    });
  }
}
process.exit(failed ? 1 : 0);
