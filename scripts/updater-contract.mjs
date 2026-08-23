import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_PLATFORMS = [
  'windows-x86_64',
  'darwin-universal',
  'linux-x86_64',
];

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseVersion(tag) {
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error(`release tag must be stable exact SemVer with a leading v: ${tag}`);
  }
  return tag.slice(1);
}

export function validateUpdaterManifest({ manifest, tag, tauriVersion, repository = 'Dumoedss/omnicross' }) {
  const expectedVersion = releaseVersion(tag);
  const errors = [];
  if (tauriVersion !== expectedVersion) errors.push(`Tauri version ${tauriVersion} does not match tag ${tag}`);
  if (!STABLE_SEMVER.test(manifest?.version ?? '') || manifest.version !== expectedVersion) {
    errors.push(`manifest version ${manifest?.version ?? '<missing>'} does not match tag ${tag}`);
  }

  const platforms = manifest?.platforms && typeof manifest.platforms === 'object' ? manifest.platforms : {};
  const keys = Object.keys(platforms).sort();
  const required = [...REQUIRED_PLATFORMS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(required)) {
    errors.push(`platforms must be exactly: ${required.join(', ')}`);
  }
  for (const target of REQUIRED_PLATFORMS) {
    const entry = platforms[target];
    if (!entry) continue;
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      errors.push(`${target} URL is invalid`);
      continue;
    }
    const expectedPrefix = `/${repository}/releases/download/${tag}/`;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedPrefix) || url.search || url.hash) {
      errors.push(`${target} URL must be an immutable HTTPS GitHub release asset for ${tag}`);
    }
    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') {
      errors.push(`${target} signature is missing`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return true;
}

function oneAsset(files, target, matcher) {
  const matches = files.filter((name) => matcher.test(name) && !name.endsWith('.sig'));
  if (matches.length !== 1) {
    throw new Error(`${target} requires exactly one updater asset, found: ${matches.join(', ') || '<none>'}`);
  }
  const signature = `${matches[0]}.sig`;
  if (!files.includes(signature)) throw new Error(`${target} signature asset is missing: ${signature}`);
  return { asset: matches[0], signature };
}

function selectUpdaterAssets(assetsDir) {
  const files = readdirSync(assetsDir);
  return {
    'windows-x86_64': oneAsset(files, 'windows-x86_64', /_x64-setup\.exe$/i),
    'darwin-universal': oneAsset(files, 'darwin-universal', /_universal\.app\.tar\.gz$/i),
    'linux-x86_64': oneAsset(files, 'linux-x86_64', /_(amd64|x86_64)\.AppImage\.tar\.gz$/),
  };
}

export function verifyUpdaterArtifacts({ assetsDir, publicKey }) {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new Error('Tauri updater public key is missing');
  }
  const selections = selectUpdaterAssets(assetsDir);
  const verifierManifest = fileURLToPath(new URL('./updater-signature-verifier/Cargo.toml', import.meta.url));
  const pairs = Object.values(selections).flatMap(({ asset, signature }) => [
    join(assetsDir, asset),
    join(assetsDir, signature),
  ]);
  const result = spawnSync('cargo', [
    'run', '--quiet', '--locked', '--manifest-path', verifierManifest, '--', publicKey, ...pairs,
  ], { encoding: 'utf8' });
  if (result.error) throw new Error(`could not run updater signature verifier: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim() || 'signature verification failed';
    throw new Error(diagnostic);
  }
  return true;
}

export function assembleUpdaterManifest({ assetsDir, tag, repository = 'Dumoedss/omnicross', pubDate = new Date().toISOString() }) {
  const version = releaseVersion(tag);
  const selections = selectUpdaterAssets(assetsDir);
  const platforms = Object.fromEntries(Object.entries(selections).map(([target, selected]) => {
    const signature = readFileSync(join(assetsDir, selected.signature), 'utf8').trim();
    return [target, {
      signature,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(selected.asset)}`,
    }];
  }));
  return {
    version,
    notes: `See the Omnicross ${tag} release page for details.`,
    pub_date: pubDate,
    platforms,
  };
}

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`invalid argument near ${argv[index] ?? '<end>'}`);
    parsed[key] = value;
  }
  return parsed;
}

export function runCli(argv) {
  const options = args(argv);
  if (!options.tag || !options['tauri-config']) throw new Error('--tag and --tauri-config are required');
  const tauriConfig = JSON.parse(readFileSync(resolve(options['tauri-config']), 'utf8'));
  let manifest;
  if (options.assets) {
    if (!options.output) throw new Error('--output is required with --assets');
    verifyUpdaterArtifacts({
      assetsDir: resolve(options.assets),
      publicKey: tauriConfig?.plugins?.updater?.pubkey,
    });
    manifest = assembleUpdaterManifest({
      assetsDir: resolve(options.assets),
      tag: options.tag,
      repository: options.repository,
    });
    writeFileSync(resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } else {
    if (!options.manifest) throw new Error('--manifest or --assets is required');
    manifest = JSON.parse(readFileSync(resolve(options.manifest), 'utf8'));
  }
  validateUpdaterManifest({
    manifest,
    tag: options.tag,
    tauriVersion: tauriConfig.version,
    repository: options.repository,
  });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const manifest = runCli(process.argv.slice(2));
    console.log(`Updater contract valid for ${manifest.version}: ${REQUIRED_PLATFORMS.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
