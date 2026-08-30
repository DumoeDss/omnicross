import { validateImagesServerConfig } from '@omnicross/core/outbound-api';

import { validateImageRootCandidate } from './imagePathResolver';

export interface ImagesAdminValidationOptions {
  readonly remoteResolverAvailable?: boolean;
  readonly processDirectory?: string;
  readonly userHome?: string;
}

/** Adds host filesystem and composed-resolver policy to core's strict shape checks. */
export function validateImagesAdminConfig(
  value: unknown,
  options: ImagesAdminValidationOptions = {},
): string[] {
  const errors = validateImagesServerConfig(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;
  const config = value as Record<string, unknown>;
  const remote = config['remote'];
  if (
    remote && typeof remote === 'object' && !Array.isArray(remote) &&
    (remote as Record<string, unknown>)['enabled'] === true &&
    options.remoteResolverAvailable !== true
  ) {
    errors.push('images.remote.enabled requires a proven composed remote resolver');
  }

  const references = config['references'];
  if (!references || typeof references !== 'object' || Array.isArray(references)) return errors;
  const storageRoot = (references as Record<string, unknown>)['storageRoot'];
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) return errors;
  errors.push(...validateImageRootCandidate(storageRoot, {
    label: 'images.references.storageRoot',
    processDirectory: options.processDirectory,
    userHome: options.userHome,
  }));
  return errors;
}
