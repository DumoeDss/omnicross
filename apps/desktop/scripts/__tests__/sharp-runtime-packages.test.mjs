import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveSharpRuntimeNativePackageNames,
  resolveSharpRuntimePackageNames,
  resolveSharpRuntimePackageSpecs,
} from '../sharp-runtime-packages.mjs';

test('selects the Sharp native package for the Windows release target', () => {
  assert.deepEqual(
    resolveSharpRuntimePackageNames({ platform: 'win32', arch: 'x64' }),
    ['@img/sharp-win32-x64'],
  );
});

test('selects both Sharp native packages for a universal macOS release', () => {
  assert.deepEqual(
    resolveSharpRuntimeNativePackageNames({
      platform: 'darwin',
      arch: 'arm64',
      nodeTarget: 'darwin-universal',
    }),
    ['@img/sharp-darwin-arm64', '@img/sharp-darwin-x64'],
  );
});

test('selects glibc and musl Linux packages independently', () => {
  assert.deepEqual(
    resolveSharpRuntimePackageNames({ platform: 'linux', arch: 'x64', libc: 'glibc' }),
    ['@img/sharp-libvips-linux-x64', '@img/sharp-linux-x64'],
  );
  assert.deepEqual(
    resolveSharpRuntimePackageNames({ platform: 'linux', arch: 'arm64', libc: 'musl' }),
    ['@img/sharp-libvips-linuxmusl-arm64', '@img/sharp-linuxmusl-arm64'],
  );
});

test('includes both libvips and native addons for a universal macOS release', () => {
  assert.deepEqual(
    resolveSharpRuntimePackageNames({
      platform: 'darwin',
      arch: 'arm64',
      nodeTarget: 'darwin-universal',
    }),
    [
      '@img/sharp-libvips-darwin-arm64',
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-x64',
      '@img/sharp-darwin-x64',
    ],
  );
});

test('uses exact versions declared by the installed Sharp package', () => {
  const manifest = {
    optionalDependencies: {
      '@img/sharp-win32-x64': '0.35.4',
      '@img/sharp-darwin-arm64': '0.35.4',
    },
  };

  assert.deepEqual(
    resolveSharpRuntimePackageSpecs(manifest, ['@img/sharp-win32-x64']),
    ['@img/sharp-win32-x64@0.35.4'],
  );
  assert.throws(
    () => resolveSharpRuntimePackageSpecs(manifest, ['@img/sharp-linux-x64']),
    /does not declare @img\/sharp-linux-x64/,
  );
  assert.throws(
    () =>
      resolveSharpRuntimePackageSpecs(
        { optionalDependencies: { '@img/sharp-win32-x64': '^0.35.4' } },
        ['@img/sharp-win32-x64'],
      ),
    /does not declare @img\/sharp-win32-x64/,
  );
});

test('rejects release targets that Sharp does not publish', () => {
  assert.throws(
    () => resolveSharpRuntimePackageNames({ platform: 'win32', arch: 's390x' }),
    /Unsupported Sharp runtime target/,
  );
});
