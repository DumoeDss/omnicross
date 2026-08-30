import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertMinimumNodeMajor } from '../require-node-major.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

test('the SDK contributor guard rejects Node 21 and accepts Node 22+', () => {
  assert.throws(() => assertMinimumNodeMajor('v21.9.0', 22), /requires Node\.js 22/);
  assert.doesNotThrow(() => assertMinimumNodeMajor('v22.0.0', 22));
  assert.doesNotThrow(() => assertMinimumNodeMajor('v24.1.0', 22));
});

test('the SDK stays tooling-only while core keeps its published runtime contract', async () => {
  const root = await readJson('../../package.json');
  const core = await readJson('../../packages/core/package.json');
  assert.equal(core.engines.node, '>=20.9');
  assert.equal(core.devDependencies.openai, undefined);
  assert.equal(root.devDependencies.openai, '^7.8.0');
  assert.match(root.scripts['test:images-sdk-contract'], /^node scripts\/require-node-major\.mjs 22 && /);
});
