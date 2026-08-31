import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IMAGE_SERVER_HARD_CEILINGS } from '@omnicross/core/outbound-api';
import type { CodexImageCapabilityObservation } from '@omnicross/subscriptions';

import {
  FileCodexImageCapabilityEvidenceManifestOwner,
  FileCodexImageCapabilityEvidenceSource,
} from '../FileCodexImageCapabilityEvidenceSource';
import { createDaemonImagePathResolver } from '../imagePathResolver';

const roots: string[] = [];
const PHYSICAL_RETENTION_TTL_MS = IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs;

function environment() {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-evidence-'));
  roots.push(root);
  const paths = createDaemonImagePathResolver({
    configPath: join(root, 'config.json'),
  });
  return { root, paths };
}

function observation(accountId = 'RAW_ACCOUNT_ID_SENTINEL'): CodexImageCapabilityObservation {
  return {
    accountId,
    model: 'gpt-image-2',
    request: {
      action: 'generate',
      n: 1,
      quality: 'low',
      size: 'auto',
      background: 'opaque',
      outputFormat: 'png',
      moderation: 'auto',
      stream: false,
      partialImages: 0,
    },
    responseFields: { usage: true },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FileCodexImageCapabilityEvidenceSource', () => {
  it('retains an independent first short-doctor row for a long resident and restart', async () => {
    const { paths } = environment();
    const salt = Buffer.alloc(32, 2);
    let now = 100;
    const resident = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => now,
    });
    const doctorProcess = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 40,
      hmacSalt: salt,
      now: () => now,
    });
    expect(resident.status()).toMatchObject({ entries: 0, freshEntries: 0 });

    await doctorProcess.recordSuccessfulVerification(observation('resident-account'));
    const manifestPath = join(paths.paths.evidenceRoot, 'codex-image-capability-evidence.v1.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ expiresAt: number }>;
    };
    expect(manifest.entries[0]?.expiresAt).toBe(100 + PHYSICAL_RETENTION_TTL_MS);

    now = 141;
    const evidence = await resident.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    });
    expect(evidence.account).toMatchObject({
      verifiedAt: 100,
      expiresAt: 200,
      values: { available: true },
    });
    await expect(doctorProcess.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ account: { verifiedAt: 100, expiresAt: 140 } });
    await expect(doctorProcess.cleanup(now, 10)).resolves.toEqual({
      entriesRemoved: 0,
      bytesRemoved: 0,
    });
    expect(evidence.account.values?.available).toBe(true);
    expect(resident.status()).toMatchObject({ entries: 1, freshEntries: 1 });

    const restartedResident = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => now,
    });
    await expect(restartedResident.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ account: { expiresAt: 200, values: { available: true } } });

    resident.dispose();
    doctorProcess.dispose();
    restartedResident.dispose();
    now = 100 + PHYSICAL_RETENTION_TTL_MS;
    await expect(doctorProcess.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 1 });
  });

  it('extends a legacy prior floor on the exact independent late-doctor reproduction', async () => {
    const { paths } = environment();
    const salt = Buffer.alloc(32, 13);
    let now = 100;
    const resident = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => now,
    });
    await resident.recordSuccessfulVerification(observation('resident-account'));

    // Recreate the Round-3 row: original verification 100, prior physical floor 200.
    const manifestPath = join(paths.paths.evidenceRoot, 'codex-image-capability-evidence.v1.json');
    const legacyManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ expiresAt: number }>;
    };
    legacyManifest.entries[0]!.expiresAt = 200;
    writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2) + '\n', 'utf8');

    now = 190;
    const independentDoctor = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 40,
      hmacSalt: salt,
      now: () => now,
    });
    await independentDoctor.recordSuccessfulVerification(observation('resident-account'));

    const refreshedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ verifiedAt: number; expiresAt: number }>;
    };
    expect(refreshedManifest.entries[0]).toMatchObject({
      verifiedAt: 190,
      expiresAt: 190 + PHYSICAL_RETENTION_TTL_MS,
    });

    now = 231;
    await expect(resident.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      account: { verifiedAt: 190, expiresAt: 290, values: { available: true } },
    });
    const shortEvidence = await independentDoctor.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    });
    expect(shortEvidence.account).toMatchObject({ verifiedAt: 190, expiresAt: 230 });
    expect(shortEvidence.account).not.toHaveProperty('values');
    await expect(independentDoctor.cleanup(now, 10)).resolves.toEqual({
      entriesRemoved: 0,
      bytesRemoved: 0,
    });

    const restartedResident = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => now,
    });
    await expect(restartedResident.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ account: { expiresAt: 290, values: { available: true } } });

    now = 190 + PHYSICAL_RETENTION_TTL_MS;
    await expect(restartedResident.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 1 });
  });

  it('restores the resident logical window when an independent doctor rewrites after the old floor', async () => {
    const { paths } = environment();
    const salt = Buffer.alloc(32, 15);
    let now = 100;
    const resident = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => now,
    });
    await resident.recordSuccessfulVerification(observation('resident-account'));

    const manifestPath = join(paths.paths.evidenceRoot, 'codex-image-capability-evidence.v1.json');
    const legacyManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ expiresAt: number }>;
    };
    legacyManifest.entries[0]!.expiresAt = 200;
    writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2) + '\n', 'utf8');

    now = 201;
    const independentDoctor = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 40,
      hmacSalt: salt,
      now: () => now,
    });
    await independentDoctor.recordSuccessfulVerification(observation('resident-account'));

    now = 242;
    await expect(independentDoctor.cleanup(now, 10)).resolves.toEqual({
      entriesRemoved: 0,
      bytesRemoved: 0,
    });
    await expect(resident.resolve({
      accountId: 'resident-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      account: { verifiedAt: 201, expiresAt: 301, values: { available: true } },
    });

    now = 201 + PHYSICAL_RETENTION_TTL_MS;
    await expect(independentDoctor.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 1 });
  });

  it('persists an allow-listed account-HMAC row and restores exact fresh evidence', async () => {
    const { paths } = environment();
    let now = 1_000;
    const source = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 3),
    });
    await source.recordSuccessfulVerification(observation());

    const manifestPath = join(paths.paths.evidenceRoot, 'codex-image-capability-evidence.v1.json');
    const manifestText = readFileSync(manifestPath, 'utf8');
    expect(manifestText).not.toContain('RAW_ACCOUNT_ID_SENTINEL');
    expect(manifestText).not.toMatch(/Bearer|Cookie|prompt|base64|image bytes|requestBody|responseBody/i);
    const manifest = JSON.parse(manifestText) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(manifest.entries).toHaveLength(1);
    expect(Object.keys(manifest.entries[0]!).sort()).toEqual([
      'accountKey', 'expiresAt', 'model', 'provider', 'responseFields', 'sourceVersion',
      'tested', 'verifiedAt',
    ].sort());
    expect(manifest.entries[0]?.accountKey).toMatch(/^[a-f0-9]{64}$/);

    const restarted = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 3),
    });
    const evidence = await restarted.resolve({
      accountId: 'RAW_ACCOUNT_ID_SENTINEL',
      signal: new AbortController().signal,
    });
    expect(evidence.account).toMatchObject({
      kind: 'account',
      source: 'codex-image-live-verifier-v1',
      verifiedAt: 1_000,
      expiresAt: 1_100,
      values: {
        available: true,
        models: ['gpt-image-2'],
        generate: true,
        edit: false,
        outputFormats: ['png'],
        qualityLevels: ['low'],
        moderationModes: ['auto'],
        transparentBackground: false,
        flexibleSizes: false,
        responsesTool: true,
      },
    });
    expect(evidence.upstream).toMatchObject({ kind: 'upstream', values: { available: true } });
    expect(evidence.verifiedResponseFields).toEqual({ usage: true });
    expect(restarted.status()).toMatchObject({ entries: 1, freshEntries: 1, staleEntries: 0 });

    now = 1_101;
    const stale = await restarted.resolve({
      accountId: 'RAW_ACCOUNT_ID_SENTINEL',
      signal: new AbortController().signal,
    });
    expect(stale.account).toMatchObject({ expiresAt: 1_100 });
    expect(stale.account).not.toHaveProperty('values');
    expect(stale.upstream).not.toHaveProperty('values');
    expect(restarted.status()).toMatchObject({ freshEntries: 0, staleEntries: 1 });

    const other = await restarted.resolve({
      accountId: 'another-account',
      signal: new AbortController().signal,
    });
    expect(other.account).toEqual({
      kind: 'account',
      source: 'codex-image-entitlement-unknown',
    });
  });

  it('clamps restored evidence to a shorter current TTL without rejecting the manifest', async () => {
    const { paths } = environment();
    let now = 100;
    const original = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 4),
    });
    await original.recordSuccessfulVerification(observation('account-a'));

    const reconfigured = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 40,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 4),
    });
    now = 141;
    const evidence = await reconfigured.resolve({
      accountId: 'account-a',
      signal: new AbortController().signal,
    });
    expect(evidence.account).toMatchObject({ verifiedAt: 100, expiresAt: 140 });
    expect(evidence.account).not.toHaveProperty('values');
  });

  it('rejects a logical TTL outside the authoritative physical envelope', () => {
    const { paths } = environment();
    expect(() => new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: PHYSICAL_RETENTION_TTL_MS + 1,
      hmacSalt: Buffer.alloc(32, 14),
    })).toThrow(/hard ceiling/i);
  });

  it('rejects a manifest row whose physical expiry exceeds the global envelope', async () => {
    const { paths } = environment();
    const salt = Buffer.alloc(32, 16);
    const source = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => 100,
    });
    await source.recordSuccessfulVerification(observation('resident-account'));

    const manifestPath = join(paths.paths.evidenceRoot, 'codex-image-capability-evidence.v1.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ expiresAt: number }>;
    };
    manifest.entries[0]!.expiresAt = 100 + PHYSICAL_RETENTION_TTL_MS + 1;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    expect(() => new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: salt,
      now: () => 100,
    })).toThrow(/invalid entry/i);
  });

  it('keeps logical TTL views immutable while cleanup follows the global physical envelope', async () => {
    const { paths } = environment();
    let now = 100;
    const owner = new FileCodexImageCapabilityEvidenceManifestOwner({
      paths,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 12),
    });
    const longWindow = owner.createSource(100);
    const shortWindow = owner.createSource(40);
    await longWindow.recordSuccessfulVerification(observation('generation-account'));

    now = 110;
    await shortWindow.recordSuccessfulVerification(observation('generation-account'));

    now = 151;
    const longEvidence = await longWindow.resolve({
      accountId: 'generation-account',
      signal: new AbortController().signal,
    });
    const shortEvidence = await shortWindow.resolve({
      accountId: 'generation-account',
      signal: new AbortController().signal,
    });
    expect(longEvidence.account).toMatchObject({
      verifiedAt: 110,
      expiresAt: 210,
      values: { available: true },
    });
    expect(shortEvidence.account).toMatchObject({ verifiedAt: 110, expiresAt: 150 });
    expect(shortEvidence.account).not.toHaveProperty('values');

    await expect(owner.cleanup(now, 10)).resolves.toEqual({
      entriesRemoved: 0,
      bytesRemoved: 0,
    });
    expect(longWindow.status()).toMatchObject({ entries: 1, freshEntries: 1 });
    expect(shortWindow.status()).toMatchObject({ entries: 1, staleEntries: 1 });

    longWindow.dispose();
    shortWindow.dispose();
    now = 211;
    await expect(owner.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 0 });
    now = 110 + PHYSICAL_RETENTION_TTL_MS;
    await expect(owner.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 1 });
    expect(owner.createSource(40).status()).toMatchObject({ entries: 0 });
  });

  it('rejects unknown observation and manifest fields without persisting sentinels', async () => {
    const { paths } = environment();
    const source = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: Buffer.alloc(32, 5),
    });
    await expect(source.recordSuccessfulVerification({
      ...observation(),
      prompt: 'PROMPT_SECRET_SENTINEL',
      credential: 'Bearer TOKEN_SECRET_SENTINEL',
    } as never)).rejects.toThrow(/observation is invalid/i);
    expect(source.status().entries).toBe(0);

    writeFileSync(
      join(paths.paths.evidenceRoot, 'codex-image-capability-evidence.v1.json'),
      JSON.stringify({ version: 1, revision: 1, entries: [], prompt: 'PROMPT_SECRET_SENTINEL' }),
      'utf8',
    );
    expect(() => new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      hmacSalt: Buffer.alloc(32, 5),
    })).toThrow(/manifest is invalid/i);
  });

  it('keeps failed publication atomic and cleans expired entries in bounded passes', async () => {
    const first = environment();
    const failing = new FileCodexImageCapabilityEvidenceSource({
      paths: first.paths,
      ttlMs: 10,
      hmacSalt: Buffer.alloc(32, 6),
      replaceManifest: () => { throw new Error('injected publication failure'); },
    });
    await expect(failing.recordSuccessfulVerification(observation('account-fail')))
      .rejects.toThrow(/publication failure/i);
    expect(failing.status().entries).toBe(0);

    const second = environment();
    let now = 200;
    const source = new FileCodexImageCapabilityEvidenceSource({
      paths: second.paths,
      ttlMs: 10,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 7),
    });
    await source.recordSuccessfulVerification(observation('account-a'));
    await source.recordSuccessfulVerification(observation('account-b'));
    now = 200 + PHYSICAL_RETENTION_TTL_MS;
    const firstPass = await source.cleanup(now, 1);
    expect(firstPass.entriesRemoved).toBe(1);
    expect(firstPass.bytesRemoved).toBeGreaterThan(0);
    expect(source.status()).toMatchObject({ entries: 1, staleEntries: 1 });
    const secondPass = await source.cleanup(now, 1);
    expect(secondPass.entriesRemoved).toBe(1);
    expect(source.status()).toMatchObject({ entries: 0, staleEntries: 0 });
  });

  it('uses the persistent shared salt by default across restart', async () => {
    const { paths } = environment();
    const source = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      now: () => 100,
    });
    await source.recordSuccessfulVerification(observation('persistent-account'));
    const restarted = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 100,
      now: () => 100,
    });
    const evidence = await restarted.resolve({
      accountId: 'persistent-account',
      signal: new AbortController().signal,
    });
    expect(evidence.account.values?.available).toBe(true);
  });
});
