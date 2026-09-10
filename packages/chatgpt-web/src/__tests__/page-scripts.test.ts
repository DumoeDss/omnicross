/**
 * Generated page-script syntax tests.
 *
 * Every script this package sends to Chrome is a string built in TS. A stray
 * escape inside a template literal (e.g. a comment containing a `\n` that the
 * template renders as a real newline) silently breaks the WHOLE turn with a
 * page-side SyntaxError — compile each generated script here so that class of
 * bug fails in CI instead of in the user's browser.
 *
 * @module @omnicross/chatgpt-web/chatgpt/__tests__/page-scripts.test
 */

import { compileFunction } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  chatGptResponseSnapshotScript,
  chatGptTurnIdentitiesScript,
  composerTextScript,
  fileInputPresentScript,
  insertAndVerifyComposerScript,
  insertPlainTextIntoComposerScript,
} from '../chatgpt/snapshot';

function expectCompiles(name: string, script: string): void {
  expect(() => compileFunction(script), `${name} should compile`).not.toThrow();
}

describe('generated page scripts compile', () => {
  it('insert + verify scripts survive multiline / NBSP / fenced payloads', () => {
    expectCompiles('insertAndVerify(short)', insertAndVerifyComposerScript('hello'));
    expectCompiles(
      'insertAndVerify(multiline)',
      insertAndVerifyComposerScript('line1\nline2    x\n```json\n{"a":1}\n```'),
    );
    expectCompiles('insertPlain', insertPlainTextIntoComposerScript('a\nb'));
  });

  it('composer readback and file-input scripts compile', () => {
    expectCompiles('composerText', composerTextScript());
    expectCompiles('fileInput', fileInputPresentScript());
  });

  it('turn identities and response snapshot scripts compile', () => {
    expectCompiles(
      'identities',
      chatGptTurnIdentitiesScript({
        containerSelector: '[data-turn-id-container]',
        userTurnSelector: '[data-turn="user"]',
        assistantTurnSelector: '[data-turn="assistant"]',
        stopButtonSelector: '[data-testid="stop-button"]',
        composerSelector: '[data-testid="prompt-textarea"]',
      }),
    );
    expectCompiles(
      'snapshot',
      chatGptResponseSnapshotScript({
        assistantTurnSelector: '[data-turn-id="x"]',
        userTurnSelector: '[data-turn="user"]',
        composerSelector: '[data-testid="prompt-textarea"]',
        stopButtonSelector: '[data-testid="stop-button"]',
        completionActionSelector: 'button[data-testid="copy-turn-action-button"]',
        knownKey: 'k:1:0',
      }),
    );
    expectCompiles(
      'snapshot(default selector)',
      chatGptResponseSnapshotScript({
        assistantTurnSelector: '[data-turn="assistant"]',
        userTurnSelector: '[data-turn="user"]',
        composerSelector: '[data-testid="prompt-textarea"]',
        stopButtonSelector: '[data-testid="stop-button"]',
        completionActionSelector: 'button[data-testid="copy-turn-action-button"]',
      }),
    );
  });
});
