/**
 * Proxy secret-handling tests (upstream-proxy) — sanitize/redact masking + the
 * at-rest encrypt/decrypt round-trip. Asserts the plaintext password NEVER
 * appears in any admin-facing projection and IS enveloped at rest.
 */

import type { OutboundProxyConfig } from '@omnicross/core';
import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { decryptProxySegment, encryptProxySegment, SecretBox } from '../../secrets';
import {
  preserveOutboundProxySecrets,
  preserveProxyConfigSecret,
  redactOutboundProxy,
  redactProxyConfig,
  sanitizeProxyConfig,
} from '../sanitizeProxy';

const SECRET = 'super-secret-pw';

describe('sanitizeProxyConfig', () => {
  it('masks the structured password to hasPassword + host:port endpoint', () => {
    const view = sanitizeProxyConfig({
      type: 'socks5',
      host: '10.0.0.1',
      port: 1080,
      username: 'bob',
      password: SECRET,
    });
    expect(view).toEqual({ kind: 'socks5', endpoint: '10.0.0.1:1080', username: 'bob', hasPassword: true });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('masks the url-form userinfo password (never returns the raw url)', () => {
    const view = sanitizeProxyConfig({ url: `http://bob:${SECRET}@proxy.local:3128` });
    expect(view.kind).toBe('url');
    expect(view.hasPassword).toBe(true);
    expect(view.endpoint).toBe('proxy.local:3128');
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('reports hasPassword false when absent', () => {
    expect(sanitizeProxyConfig({ type: 'http', host: 'h', port: 80 }).hasPassword).toBe(false);
  });
});

describe('redact for the server-config GET', () => {
  it('drops the structured password but keeps the shape', () => {
    const redacted = redactProxyConfig({ type: 'http', host: 'h', port: 80, password: SECRET }) as {
      password?: string;
    };
    expect(redacted.password).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
  });

  it('strips the url userinfo password across the whole segment', () => {
    const proxy: OutboundProxyConfig = {
      global: { url: `http://u:${SECRET}@g.local:8080` },
      byProvider: { claude: { type: 'http', host: 'c.local', port: 8080, password: SECRET } },
    };
    const redacted = redactOutboundProxy(proxy);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
  });
});

describe('at-rest encryption round-trip', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it('encrypts the structured password to an envelope and decrypts back', () => {
    const proxy: OutboundProxyConfig = {
      global: { type: 'http', host: 'g.local', port: 8080, password: SECRET },
      byProvider: { claude: { type: 'socks5', host: 'c.local', port: 1080, password: SECRET } },
    };
    const enc = encryptProxySegment(proxy, box);
    // Never plaintext at rest.
    expect(JSON.stringify(enc)).not.toContain(SECRET);
    const encGlobal = enc.global as Extract<ProxyConfig, { type: string }>;
    expect(encGlobal.password?.startsWith('enc:')).toBe(true);
    // Decrypt restores the plaintext.
    const dec = decryptProxySegment(enc, box);
    expect(dec).toEqual(proxy);
  });

  it('leaves a credential-free url-form proxy untouched (no secret)', () => {
    const proxy: OutboundProxyConfig = { global: { url: 'http://g.local:8080' } };
    expect(encryptProxySegment(proxy, box)).toEqual(proxy);
  });

  it('encrypts a { url }-form proxy carrying inline userinfo credentials (M4)', () => {
    const proxy: OutboundProxyConfig = {
      global: { url: `http://user:${SECRET}@g.local:8080` },
    };
    const enc = encryptProxySegment(proxy, box);
    // The whole url is enveloped — no plaintext password at rest.
    expect(JSON.stringify(enc)).not.toContain(SECRET);
    expect((enc.global as { url: string }).url.startsWith('enc:')).toBe(true);
    // Decrypt restores the original credentialed url.
    expect(decryptProxySegment(enc, box)).toEqual(proxy);
  });
});

describe('write-only password preservation', () => {
  it('carries the current structured password forward when the incoming blanks it', () => {
    const incoming: ProxyConfig = { type: 'http', host: 'h', port: 80 }; // masked GET (no password)
    const current: ProxyConfig = { type: 'http', host: 'h', port: 80, password: SECRET };
    expect(preserveProxyConfigSecret(incoming, current)).toEqual({
      type: 'http',
      host: 'h',
      port: 80,
      password: SECRET,
    });
  });

  it('honors a newly-typed password over the current one', () => {
    const incoming: ProxyConfig = { type: 'http', host: 'h', port: 80, password: 'new-pw' };
    const current: ProxyConfig = { type: 'http', host: 'h', port: 80, password: SECRET };
    expect(preserveProxyConfigSecret(incoming, current)).toEqual(incoming);
  });

  it('restores a stripped url-form userinfo password', () => {
    const incoming: ProxyConfig = { url: 'http://user@g.local:8080' }; // password stripped
    const current: ProxyConfig = { url: `http://user:${SECRET}@g.local:8080` };
    const result = preserveProxyConfigSecret(incoming, current) as { url: string };
    expect(new URL(result.url).password).toBe(SECRET);
  });

  it('preserves each untouched layer across a whole segment', () => {
    const incoming: OutboundProxyConfig = {
      global: { type: 'http', host: 'g', port: 80 },
      byProvider: { claude: { type: 'socks5', host: 'c', port: 1080 } },
    };
    const current: OutboundProxyConfig = {
      global: { type: 'http', host: 'g', port: 80, password: SECRET },
      byProvider: { claude: { type: 'socks5', host: 'c', port: 1080, password: SECRET } },
    };
    const merged = preserveOutboundProxySecrets(incoming, current);
    expect((merged.global as { password?: string }).password).toBe(SECRET);
    expect((merged.byProvider?.claude as { password?: string }).password).toBe(SECRET);
  });

  it('does not invent a password when neither side has one', () => {
    const incoming: ProxyConfig = { type: 'http', host: 'h', port: 80 };
    expect(preserveProxyConfigSecret(incoming, undefined)).toEqual(incoming);
    expect(preserveProxyConfigSecret(incoming, { type: 'http', host: 'h', port: 80 })).toEqual(incoming);
  });
});
