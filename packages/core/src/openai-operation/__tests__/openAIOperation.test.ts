import { describe, expect, it } from 'vitest';

import { classifyOpenAIOperation } from '../openAIOperation';

describe('classifyOpenAIOperation', () => {
  it.each([
    ['/v1/responses', 'responses.create'],
    ['/openai/responses?stream=true', 'responses.create'],
    ['/nested/base/responses///', 'responses.create'],
    ['/v1/responses/compact', 'responses.compact'],
    ['/openai/responses/compact/?model=gpt-5.6', 'responses.compact'],
    ['/v1/chat/completions', 'chat.completions.create'],
    ['/gateway/openai/chat/completions/', 'chat.completions.create'],
    ['/v1/images/generations', 'images.generate'],
    ['/openai/images/edits?purpose=test', 'images.edit'],
  ])('classifies POST %s as %s', (url, id) => {
    expect(classifyOpenAIOperation('POST', url)?.id).toBe(id);
  });

  it.each([
    ['GET', '/v1/responses'],
    ['POST', '/v1/responses/compact/more'],
    ['POST', '/v1/not-responses'],
    ['POST', '/v1/chat/completions-extra'],
    ['POST', '/v1/images/generation'],
    ['POST', '/v1/images'],
    ['POST', ''],
  ])('rejects unsupported %s %s', (method, url) => {
    expect(classifyOpenAIOperation(method, url)).toBeNull();
  });

  it('keeps policy ownership separate from implementation ownership', () => {
    expect(classifyOpenAIOperation('POST', '/v1/responses')).toMatchObject({
      policyFamily: 'responses',
      routeFamily: 'responses',
      owner: 'builtin',
      bodyKind: 'json',
      requestedModelSource: 'request',
    });
    expect(classifyOpenAIOperation('POST', '/v1/responses/compact')).toMatchObject({
      policyFamily: 'responses',
      routeFamily: 'responses',
      owner: 'extension',
      bodyKind: 'json',
      requestedModelSource: 'request',
    });
    expect(classifyOpenAIOperation('POST', '/v1/images/edits')).toMatchObject({
      policyFamily: 'images',
      routeFamily: 'images',
      owner: 'extension',
      bodyKind: 'multipart',
      requestedModelSource: 'configured',
    });
  });
});
