import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { atomicReplaceUtf8 } from '../ports/atomicFile';

interface Verifier {
  version: 1;
  salt: string;
  hash: string;
  failures: number;
  lockedUntil: number;
}

export class KeyViewingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// Shared by all wrappers for a config file. Authentication and its individual
// read/reset are one operation; no reusable unlock token ever leaves the daemon.
const queues = new Map<string, Promise<unknown>>();

export class KeyViewingPassword {
  readonly path: string;
  constructor(configPath: string) {
    if (typeof configPath !== 'string' || !configPath) throw new KeyViewingError(503, 'view-password-unavailable');
    this.path = `${resolve(configPath)}.key-viewing.json`;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.path) ?? Promise.resolve()).then(operation);
    const settled = result.catch(() => undefined);
    queues.set(this.path, settled);
    void settled.then(() => { if (queues.get(this.path) === settled) queues.delete(this.path); });
    return result;
  }

  private load(): Verifier | null {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new KeyViewingError(503, 'view-password-unavailable');
    }
    try {
      const record = JSON.parse(raw) as Verifier | null;
      if (record === null) return null; // Explicitly disabled, persisted atomically.
      if (record.version !== 1 || typeof record.salt !== 'string' || typeof record.hash !== 'string' ||
          !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{64}$/.test(record.hash) || !Number.isSafeInteger(record.failures) ||
          record.failures < 0 || !Number.isSafeInteger(record.lockedUntil) || record.lockedUntil < 0) throw new Error();
      return record;
    } catch { throw new KeyViewingError(503, 'view-password-unavailable'); }
  }

  private save(record: Verifier | null): void {
    try { atomicReplaceUtf8(this.path, `${JSON.stringify(record)}\n`); }
    catch { throw new KeyViewingError(503, 'view-password-unavailable'); }
  }

  private derive(password: string, salt: string): Promise<Buffer> {
    return new Promise((accept, reject) => scrypt(password, Buffer.from(salt, 'hex'), 32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : accept(key)));
  }

  private validateNew(password: unknown): asserts password is string {
    if (typeof password !== 'string' || password.length < 4 || password.length > 8) {
      throw new KeyViewingError(400, 'view-password-length');
    }
  }

  private async verify(password: unknown): Promise<void> {
    const record = this.load();
    if (!record) return;
    if (record.lockedUntil > Date.now()) throw new KeyViewingError(429, 'view-password-locked');
    if (password === undefined || password === '') throw new KeyViewingError(403, 'view-password-required');
    if (typeof password !== 'string' || password.length > 128) throw new KeyViewingError(403, 'view-password-invalid');
    const candidate = await this.derive(password, record.salt);
    if (!timingSafeEqual(candidate, Buffer.from(record.hash, 'hex'))) {
      record.failures += 1;
      if (record.failures >= 5) record.lockedUntil = Date.now() + 60_000;
      this.save(record);
      throw new KeyViewingError(record.lockedUntil > Date.now() ? 429 : 403,
        record.lockedUntil > Date.now() ? 'view-password-locked' : 'view-password-invalid');
    }
    this.save({ ...record, failures: 0, lockedUntil: 0 });
  }

  private async install(password: string): Promise<void> {
    const salt = randomBytes(16).toString('hex');
    const hash = (await this.derive(password, salt)).toString('hex');
    this.save({ version: 1, salt, hash, failures: 0, lockedUntil: 0 });
  }

  status(): Promise<{ enabled: boolean }> {
    return this.exclusive(async () => ({ enabled: this.load() !== null }));
  }

  read<T>(password: unknown, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const record = this.load();
      if (!record) {
        if (password === undefined || password === '') {
          throw new KeyViewingError(403, 'view-password-not-set');
        }
        this.validateNew(password);
        // First reveal doubles as setup. Installing before the operation means
        // future reads always require verification, including if this read
        // later fails (for example, the selected provider disappeared).
        await this.install(password);
        return operation();
      }
      await this.verify(password);
      return operation();
    });
  }

  change(current: unknown, next: unknown): Promise<void> {
    return this.exclusive(async () => {
      if (next !== null) this.validateNew(next);
      await this.verify(current);
      if (next === null) this.save(null);
      else await this.install(next as string);
    });
  }

  reset(next: unknown, clearCredentials: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      this.validateNew(next);
      // Never replace the verifier until ALL old exportable credentials are gone.
      await clearCredentials();
      await this.install(next);
    });
  }
}
