const SUPPORTED_ARCHES = {
  darwin: new Set(['arm64', 'x64']),
  linux: new Set(['arm64', 'x64']),
  win32: new Set(['x64']),
};

function unsupportedTarget(platform, arch, libc) {
  const suffix = platform === 'linux' ? ` (${libc})` : '';
  throw new Error(`Unsupported Sharp runtime target: ${platform}-${arch}${suffix}`);
}

export function detectLinuxLibc(report = process.report?.getReport()) {
  return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

export function currentSharpRuntimeTarget() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeTarget: process.env.OMNICROSS_NODE_TARGET,
    libc: process.platform === 'linux' ? detectLinuxLibc() : undefined,
  };
}

export function resolveSharpRuntimeNativePackageNames({
  platform,
  arch,
  nodeTarget,
  libc = 'glibc',
}) {
  if (platform === 'darwin' && nodeTarget === 'darwin-universal') {
    return ['@img/sharp-darwin-arm64', '@img/sharp-darwin-x64'];
  }

  if (!SUPPORTED_ARCHES[platform]?.has(arch)) {
    unsupportedTarget(platform, arch, libc);
  }

  if (platform === 'win32') return [`@img/sharp-win32-${arch}`];
  if (platform === 'darwin') return [`@img/sharp-darwin-${arch}`];
  if (platform === 'linux') {
    if (libc !== 'glibc' && libc !== 'musl') unsupportedTarget(platform, arch, libc);
    return [`@img/sharp-${libc === 'musl' ? 'linuxmusl' : 'linux'}-${arch}`];
  }

  unsupportedTarget(platform, arch, libc);
}

export function resolveSharpRuntimePackageNames(target) {
  const nativePackages = resolveSharpRuntimeNativePackageNames(target);
  if (target.platform === 'win32') return nativePackages;

  return nativePackages.flatMap((packageName) => [
    packageName.replace('@img/sharp-', '@img/sharp-libvips-'),
    packageName,
  ]);
}

export function resolveSharpRuntimePackageSpecs(sharpManifest, packageNames) {
  const optionalDependencies = sharpManifest?.optionalDependencies ?? {};
  return packageNames.map((packageName) => {
    const version = optionalDependencies[packageName];
    if (
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ) {
      throw new Error(`Installed Sharp does not declare ${packageName} as an optional dependency`);
    }
    return `${packageName}@${version}`;
  });
}
