import { resolve } from 'node:path';

export interface CodexAuthHelperConfig {
  command: string;
  args: string[];
}

/**
 * Point Codex at the same daemon CLI entrypoint that is running now. Packaged
 * desktop builds execute that entrypoint with their bundled private Node
 * runtime; npm installs use the current Node binary and resolved cli.js.
 */
export function currentProcessCodexAuthHelper(
  configPath: string,
  masterKeyFilePath?: string,
): CodexAuthHelperConfig {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('cannot configure Codex auth helper without a daemon CLI entrypoint');
  return {
    command: process.execPath,
    args: [
      resolve(entrypoint),
      'integrations',
      'token',
      'codex',
      '--config',
      resolve(configPath),
      ...(masterKeyFilePath ? ['--master-key-file', resolve(masterKeyFilePath)] : []),
    ],
  };
}
