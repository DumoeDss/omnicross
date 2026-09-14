import { describe, expect, it } from 'vitest';

import { upsertManagedCodexSections } from '../chatgptWebCodexProfile';

const INPUT = { baseUrl: 'http://127.0.0.1:17850/v1', model: 'chatgpt-web/pro' };

describe('upsertManagedCodexSections', () => {
  it('appends both managed sections to an empty config', () => {
    const out = upsertManagedCodexSections('', INPUT);
    expect(out).toContain('[model_providers.omnicross-chatgptweb]');
    expect(out).toContain('base_url = "http://127.0.0.1:17850/v1"');
    expect(out).toContain('wire_api = "responses"');
    expect(out).toContain('env_key = "OMNICROSS_CHATGPT_WEB_TOKEN"');
    expect(out).toContain('[profiles.chatgptweb]');
    expect(out).toContain('model = "chatgpt-web/pro"');
    expect(out).toContain('model_provider = "omnicross-chatgptweb"');
    expect(out).toContain('# --- omnicross-chatgpt-web (managed) ---');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves foreign config content byte-for-byte outside managed sections', () => {
    const existing = 'model = "gpt-5.2"\nnotify = ["terminal"]\n\n[mcp_servers.fs]\ncommand = "fs-mcp"\n';
    const out = upsertManagedCodexSections(existing, INPUT);
    expect(out).toContain('model = "gpt-5.2"');
    expect(out).toContain('[mcp_servers.fs]');
    expect(out).toContain('command = "fs-mcp"');
    // The native default model line appears exactly once (not duplicated).
    expect(out.match(/^model = "gpt-5\.2"$/m)?.length).toBe(1);
  });

  it('replaces an existing managed section body and stays idempotent', () => {
    const first = upsertManagedCodexSections('model = "gpt-5.2"\n', INPUT);
    const stale = first.replace('model = "chatgpt-web/pro"', 'model = "chatgpt-web/light"');
    const again = upsertManagedCodexSections(stale, INPUT);
    expect(again).toContain('model = "chatgpt-web/pro"');
    expect(again.match(/\[profiles\.chatgptweb\]/g)?.length).toBe(1);
    expect(again.match(/\[model_providers\.omnicross-chatgptweb\]/g)?.length).toBe(1);
    // Idempotent: running twice changes nothing.
    expect(upsertManagedCodexSections(again, INPUT)).toBe(again);
  });

  it('handles a foreign profile section without touching it', () => {
    const existing = '[profiles.other]\nmodel = "gpt-5.2"\nmodel_provider = "openai"\n';
    const out = upsertManagedCodexSections(existing, INPUT);
    expect(out).toContain('[profiles.other]');
    expect(out).toContain('model_provider = "openai"');
    expect(out).toContain('[profiles.chatgptweb]');
  });
});
