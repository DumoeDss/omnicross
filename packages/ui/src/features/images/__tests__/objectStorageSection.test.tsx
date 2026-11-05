// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';
import { ObjectStorageSection } from '../ObjectStorageSection';

vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));

let root: Root;
let container: HTMLDivElement;
const config = {
  models: { 'gpt-image-2': 'codex-subscription' },
  defaultModel: 'gpt-image-2',
  aliases: {},
  providers: {},
} as unknown as ImagesServerConfig;

async function click(text: string) {
  const match = [...document.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!match) throw new Error(`Missing button ${text}`);
  await act(async () => {
    match.click();
  });
}
async function change(element: HTMLInputElement, value: string) {
  await act(async () => {
    Simulate.change(element, { target: { value } } as never);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('object storage publishing section', () => {
  it('saves an enabled S3 block with entered credentials', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        React.createElement(ObjectStorageSection, { config, busy: false, onUpdate })
      )
    );
    expect(
      container.querySelector('[data-testid="images-object-storage"]')
    ).not.toBeNull();

    const enable = container.querySelector<HTMLButtonElement>(
      '[data-testid="images-object-storage"] [role="switch"]'
    )!;
    await act(async () => {
      enable.click();
    });
    await change(container.querySelector<HTMLInputElement>('#object-storage-bucket')!, 'media-bucket');
    await change(
      container.querySelector<HTMLInputElement>('#object-storage-endpoint')!,
      'https://account.r2.cloudflarestorage.com'
    );
    await change(container.querySelector<HTMLInputElement>('#object-storage-access-key')!, 'AKIDEXAMPLE');
    await change(
      container.querySelector<HTMLInputElement>('#object-storage-secret-key')!,
      'secret-example'
    );
    await click('images.api.save');

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const saved = onUpdate.mock.calls[0][0] as ImagesServerConfig;
    expect(saved.storage).toMatchObject({
      enabled: true,
      kind: 's3',
      bucket: 'media-bucket',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      urlMode: 'signed',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-example',
    });
    expect(saved.storage?.sessionToken).toBeUndefined();
  });

  it('round-trips masked sentinel credentials untouched and surfaces save errors', async () => {
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Rejected once')).mockResolvedValue(undefined);
    const masked = {
      ...config,
      storage: {
        enabled: true,
        kind: 'oss',
        bucket: 'media-bucket',
        region: 'cn-hangzhou',
        urlMode: 'signed',
        expiresInSeconds: 3600,
        forcePathStyle: true,
        accessKeyId: '__SET__',
        secretAccessKey: '__SET__',
        sessionToken: '__SET__',
      },
    } as ImagesServerConfig;
    await act(async () =>
      root.render(React.createElement(ObjectStorageSection, { config: masked, busy: false, onUpdate }))
    );
    expect(
      container.querySelector<HTMLInputElement>('#object-storage-access-key')!.placeholder
    ).toBe('images.publishing.secretSet');

    await click('images.api.save');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Rejected once');

    await click('images.api.save');
    const saved = onUpdate.mock.calls[1][0] as ImagesServerConfig;
    expect(saved.storage).toMatchObject({
      enabled: true,
      kind: 'oss',
      accessKeyId: '__SET__',
      secretAccessKey: '__SET__',
      sessionToken: '__SET__',
    });
  });
});
