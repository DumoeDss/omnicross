import { createHmac } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { DaemonImagePathResolver } from './imagePathResolver';

const TENANT_SALT_NAME = 'tenant-hmac-salt.v1.bin';
const TENANT_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const REFERENCE_DOMAIN = Buffer.from('omnicross:image-reference:tenant:v1\0', 'utf8');
const RESPONSES_STATE_DOMAIN = Buffer.from('omnicross:responses-image-state:tenant:v1\0', 'utf8');

export type ImageTenantHmacPurpose = 'reference' | 'responses-state';

export function isImageTenantHmac(value: unknown): value is string {
  return typeof value === 'string' && TENANT_KEY_PATTERN.test(value);
}

export function deriveImageTenantHmac(
  salt: Uint8Array,
  purpose: ImageTenantHmacPurpose,
  tenantId: string,
): string {
  if (salt.byteLength !== 32) throw new TypeError('image tenant HMAC salt is invalid');
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > 512) {
    throw new TypeError('image tenant id is invalid');
  }
  const domain = purpose === 'reference' ? REFERENCE_DOMAIN : RESPONSES_STATE_DOMAIN;
  return createHmac('sha256', salt).update(domain).update(tenantId, 'utf8').digest('hex');
}

export function loadOrCreateImageTenantHmacSalt(
  paths: DaemonImagePathResolver,
  random: (bytes: number) => Buffer,
): Buffer {
  const root = paths.verifiedRoot('mountManifest');
  const path = join(root, TENANT_SALT_NAME);
  if (!existsSync(path)) {
    const salt = random(32);
    if (salt.byteLength !== 32) throw new TypeError('image tenant HMAC salt generator returned invalid bytes');
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, salt);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      return Buffer.from(salt);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve the original failure */ }
      }
    }
  }

  const beforeOpen = lstatSync(path);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.size !== 32) {
    throw new TypeError('image tenant HMAC salt is invalid');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    const afterOpen = lstatSync(path);
    if (
      !opened.isFile() || opened.size !== 32 ||
      afterOpen.isSymbolicLink() || !afterOpen.isFile() || afterOpen.size !== 32 ||
      opened.dev !== afterOpen.dev || opened.ino !== afterOpen.ino ||
      beforeOpen.dev !== afterOpen.dev || beforeOpen.ino !== afterOpen.ino
    ) throw new TypeError('image tenant HMAC salt is invalid');
    chmodSync(path, 0o600);
    const salt = readFileSync(fd);
    if (salt.byteLength !== 32) throw new TypeError('image tenant HMAC salt is invalid');
    return salt;
  } finally {
    closeSync(fd);
  }
}
