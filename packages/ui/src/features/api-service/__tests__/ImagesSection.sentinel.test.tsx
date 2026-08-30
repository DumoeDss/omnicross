import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string) => key,
}));

import type {
  ImagesServerConfig,
  SubscriptionAccountSanitized,
} from '@/daemon/types';

import { ImagesSection } from '../ImagesSection';

describe('ImagesSection sensitive DTO rendering', () => {
  it('renders safe account labels and storage policy without raw ids or paths', () => {
    const config = {
      enabled: true,
      provider: 'codex-subscription',
      defaultModel: 'gpt-image-2',
      account: { id: 'RAW_ACCOUNT_ID_SENTINEL', fallback: 'strict' },
      references: {
        storageRootConfigured: true,
        storageRoot: 'C:\\PRIVATE_PATH_SENTINEL',
      },
      remote: { enabled: false },
      prompt: 'PROMPT_SENTINEL',
      image: 'data:image/png;base64,BASE64_SENTINEL',
      providerReference: 'PROVIDER_REFERENCE_SENTINEL',
    } as unknown as ImagesServerConfig;
    const accounts = [{
      id: 'RAW_ACCOUNT_ID_SENTINEL',
      label: 'Studio account',
      enabled: true,
      group: 'creative',
      tags: [],
      status: 'authorized',
      hasAccessToken: true,
      isActive: true,
      schedulable: true,
    }] as SubscriptionAccountSanitized[];

    const markup = renderToStaticMarkup(
      <ImagesSection
        config={config}
        capability={null}
        status={null}
        accounts={accounts}
        busy={false}
        onUpdate={async () => undefined}
      />,
    );

    expect(markup).toContain('Studio account');
    expect(markup).toContain('apiService.images.storage.custom');
    for (const sentinel of [
      'RAW_ACCOUNT_ID_SENTINEL',
      'PRIVATE_PATH_SENTINEL',
      'PROMPT_SENTINEL',
      'BASE64_SENTINEL',
      'PROVIDER_REFERENCE_SENTINEL',
    ]) {
      expect(markup).not.toContain(sentinel);
    }
  });
});
