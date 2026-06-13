/**
 * secrets/index.ts — the public face of the at-rest encryption module
 * (secrets design D7).
 *
 * One self-contained module: AES-256-GCM envelope codec + master-key lifecycle
 * + the `SecretBox` tri-state wrapper + the pure config/tokens field-selectors.
 * `node:crypto` only — zero new dependencies. Consumers (config.ts via
 * `setSecretBox`, the subscription store via its constructor, the `secrets` CLI)
 * import from here.
 *
 * @module @omnicross/daemon/secrets
 */

export type { ParsedEnvelope } from './envelope';
export { decryptValue, encryptValue, ENVELOPE_PREFIX, isEnvelope, parseEnvelope } from './envelope';
export type { ResolveMasterKeyOptions } from './masterKey';
export { defaultMasterKeyPath, MASTER_KEY_ENV, resolveMasterKey } from './masterKey';
export { SecretBox } from './SecretBox';
export {
  decryptConfigSecrets,
  decryptTokens,
  encryptConfigSecrets,
  encryptTokens,
} from './secretFields';
