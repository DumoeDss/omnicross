// @vitest-environment jsdom
/**
 * Full-chain reproduction of the "save closes the dialog but reopen is empty"
 * report: the REAL section + editor + adapter against MY OWN throwaway daemon
 * (temp home, port 0). Only the transport seam is redirected to the temp
 * daemon; no real instance is touched.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key?: string, opts?: Record<string, unknown>) =>
    String(key ?? '').replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? '')),
}));

const holder = vi.hoisted(() => ({ base: '' }));
vi.mock('@/shared/state/settingsStore', () => ({
  useLlmProvidersData: () => ({ providers: [{ id: 'z-ai', models: ['glm-4.7'] }] }),
}));

vi.mock('@/daemon/httpFetch', () => ({
  daemonFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(holder.base + String(input), init),
}));

import { UpstreamMappingSection } from '../UpstreamMappingSection';

describe('UpstreamMappingSection end-to-end against a temp daemon', () => {
  let daemon: { adminServer: { start(): Promise<void>; stop(): Promise<void>; getStatus(): { url: string } }; outboundApiServer: { applyConfig(c: unknown): Promise<void>; stop(): Promise<void> }; apiKeyPool: { dispose(): void }; llmConfig: { ready(): Promise<void> } };
  let tmp: string;
  let root: Root | null = null;

  beforeAll(async () => {
    const { buildDaemon } = await import('../../../../../daemon/src/bootstrap');
    const { loadConfig } = await import('../../../../../daemon/src/config');
    tmp = mkdtempSync(join(tmpdir(), 'omnicross-ui-e2e-'));
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: [{ id: 'z-ai', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', models: ['glm-4.7'] }],
      server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
      admin: { port: 0 },
    }), 'utf8');
    daemon = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tmp, 'keys.json'),
      tokensPath: join(tmp, 'tokens.json'),
      masterKeyFilePath: join(tmp, 'master.key'),
    });
    await daemon.llmConfig.ready();
    await daemon.outboundApiServer.applyConfig({ enabled: false, networkBinding: false, endpoints: [], bindings: [], port: 0 });
    await daemon.adminServer.start();
    holder.base = daemon.adminServer.getStatus().url;
  });

  afterAll(async () => {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    document.body.innerHTML = '';
  });

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  it('saves rows and shows them again on reopen', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(UpstreamMappingSection, { upstreamKey: 'z-ai', label: 'z.ai' }));
    });
    // expand the section (its header button carries the section title)
    await act(async () => {
      const header = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('upstreams.mappings.sectionTitle'));
      if (!header) throw new Error('section header not found; body=' + document.body.innerHTML.slice(0, 400));
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    // open the editor
    const edit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'upstreams.mappings.edit')!;
    expect(edit).toBeTruthy();
    await act(async () => { edit.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    // add one row and type into it
    const add = [...document.querySelectorAll('button')].find((b) => b.textContent === 'upstreams.downstreams.mapping.add')!;
    await act(async () => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    const inputs = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[];
    const source = inputs.find((i) => i.placeholder === 'claude-sonnet-*')!;
    const target = inputs.find((i) => i.placeholder === 'glm-4.7')!;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(source, 'claude-*');
      source.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(target, 'glm-4.7');
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // save
    const save = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'common.save')!;
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    // dialog closed?
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // count badge shows 1
    await settle();
    // The persisted mapping survives on disk through the real daemon.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(tmp, 'config.json'), 'utf8')).toContain('upstreamModelMappings');
    // The section's count line replaces the passthrough note.
    const text = document.body.textContent ?? '';
    expect(text).toContain('upstreams.mappings.count');
    expect(text).not.toContain('upstreams.mappings.passthrough');
    // reopen the editor — rows must come back
    const edit2 = [...document.querySelectorAll('button')].find((b) => b.textContent === 'upstreams.mappings.edit')!;
    await act(async () => { edit2.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    const inputs2 = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[];
    const source2 = inputs2.find((i) => i.placeholder === 'claude-sonnet-*')!;
    expect(source2?.value).toBe('claude-*');
  });
});
