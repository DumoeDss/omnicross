import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertMinimumNodeMajor(version, minimumMajor) {
  const match = /^v?(\d+)\./.exec(version);
  if (!match || !Number.isSafeInteger(minimumMajor) || minimumMajor <= 0) {
    throw new TypeError('A valid Node version and positive minimum major are required.');
  }
  const actualMajor = Number(match[1]);
  if (actualMajor < minimumMajor) {
    throw new Error(
      `This contributor test requires Node.js ${minimumMajor} or newer; current runtime is ${version}.`,
    );
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const minimumMajor = Number(process.argv[2]);
  assertMinimumNodeMajor(process.version, minimumMajor);
}
