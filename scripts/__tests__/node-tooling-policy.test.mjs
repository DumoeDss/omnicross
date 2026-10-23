import assert from 'node:assert/strict';
import test from 'node:test';

import { assertMinimumNodeMajor } from '../require-node-major.mjs';


test('the SDK contributor guard rejects Node 21 and accepts Node 22+', () => {
  assert.throws(() => assertMinimumNodeMajor('v21.9.0', 22), /requires Node\.js 22/);
  assert.doesNotThrow(() => assertMinimumNodeMajor('v22.0.0', 22));
  assert.doesNotThrow(() => assertMinimumNodeMajor('v24.1.0', 22));
});

