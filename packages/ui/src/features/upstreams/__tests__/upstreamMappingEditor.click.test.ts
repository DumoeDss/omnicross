// @vitest-environment jsdom
/**
 * Throwaway reproduction for the "mapping-editor Save does nothing" report:
 * renders the real UpstreamMappingEditor in jsdom, clicks the Save button,
 * and asserts the save call fires. The network layer (agent) is mocked, so
 * this touches NO real daemon.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@/shared/state/settingsStore', () => ({
  useLlmProvidersData: () => ({ providers: [{ id: 'z-ai', models: ['glm-4.7'] }] }),
}));

const { setUpstreamMappings, listUpstreams } = vi.hoisted(() => ({
  setUpstreamMappings: vi.fn(async () => ({ success: true })),
  listUpstreams: vi.fn(async () => ({
    upstreams: [
      { key: 'z-ai', label: 'z.ai', target: { kind: 'provider', providerId: 'z-ai' }, mappings: [] },
    ],
    liveBindings: [],
  })),
}));

vi.mock('@/shared/agent', () => ({
  agent: { apiService: { listUpstreams, setUpstreamMappings } },
}));

import { UpstreamMappingEditor } from '../UpstreamMappingEditor';

describe('UpstreamMappingEditor save click', () => {
  let root: Root | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    document.body.innerHTML = '';
  });

  it('fires the save call when Save is clicked', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root!.render(React.createElement(UpstreamMappingEditor, {
        upstreamKey: 'z-ai',
        label: 'z.ai',
        onClose,
        onSaved,
      }));
    });
    // The editor mounts open and loads the catalog; let the effect settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const buttons = [...document.querySelectorAll('button')];
    const save = buttons.find((button) => button.textContent === 'common.save');
    expect(save, `save button found among: ${buttons.map((b) => b.textContent).join('|')}`).toBeTruthy();
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(setUpstreamMappings).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
