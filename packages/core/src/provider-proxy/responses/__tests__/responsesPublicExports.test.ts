import { describe, expect, it } from 'vitest';

import {
  classifyResponsesProfile,
  OpenAIOperationRegistry,
  registerResponsesCompactOperation,
  ResponsesAffinityStore,
  type ResponsesAffinityRecord,
  type ResponsesCompactRegistrationOptions,
  type ResponsesProfile,
  type ResponsesProfileDeclaration,
} from '../../../index';

describe('@omnicross/core Responses public exports', () => {
  it('registers and disposes compact through the root barrel', () => {
    const store = new ResponsesAffinityStore({ maxEntries: 4, ttlMs: 1_000 });
    const options: ResponsesCompactRegistrationOptions = { affinityStore: store };
    const registry = new OpenAIOperationRegistry();
    const dispose = registerResponsesCompactOperation(registry, options);

    expect(registry.has('responses.compact')).toBe(true);
    dispose();
    dispose();
    expect(registry.has('responses.compact')).toBe(false);
  });

  it('exposes profile and affinity types without a private-module import', () => {
    const declaration: ResponsesProfileDeclaration = {
      authMode: 'byo',
      providerApiFormat: 'openai-response',
    };
    const profile: ResponsesProfile = classifyResponsesProfile(declaration);
    const record: ResponsesAffinityRecord = {
      responseId: 'resp_public',
      providerId: 'byo:openai',
      clientScope: 'api-key:public',
      sessionKey: 'session-public',
      credential: { kind: 'byo-key', id: 'key-public' },
    };
    const store = new ResponsesAffinityStore();
    store.record(record);

    expect(profile).toBe('native');
    expect(store.lookup(record.responseId, record).credential).toEqual(record.credential);
  });
});
