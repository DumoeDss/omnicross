/**
 * Public types of the embedding entry (`@omnicross/daemon/embed`).
 *
 * Every type here is part of the embedding API's semver surface: during 0.x a
 * breaking change to any of them is called out in the CHANGELOG.
 *
 * @module @omnicross/daemon/embed/types
 */

import type { SubscriptionAccountSanitized } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import type { Logger } from '@omnicross/core/ports';
import type {
  RouteLeaseDescriptorPort,
  RouteLeaseEndpoint,
  RouteLeaseErrorCode,
  RouteLeaseExecutionRequest,
  RouteLeaseRuntime,
  RouteLeaseUpstream,
  RouteLeaseWire,
  RuntimeLaunchDescriptor,
} from '@omnicross/core/provider-proxy';
import type { FetchLike } from '@omnicross/subscriptions/oauth';

import type { ProviderView, PoolKeyView } from '../service/providerAdmin';
import type { OAuthFlowKind } from '../service/oauthAdmin';

import type { RouteLeaseDescriptorOptions } from './descriptors';

export type {
  RouteLeaseEndpoint,
  RouteLeaseErrorCode,
  RouteLeaseRuntime,
  RouteLeaseUpstream,
  RouteLeaseWire,
  RuntimeLaunchDescriptor,
  SubscriptionAccountSanitized,
  SubscriptionProviderId,
  ProviderView,
  PoolKeyView,
  OAuthFlowKind,
};

/** One-shot loopback listener seam: resolve the authorization code for `state`. */
export type LoopbackCodeListener = (
  state: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<string>;

/** Options for {@link createEmbeddedHost}. */
export interface EmbeddedHostOptions {
  /**
   * The ONLY directory the host writes to: `config.json` (providers + key
   * pools), `tokens.json` (subscription accounts) and, by default, the master
   * key. Created when missing.
   */
  readonly dataDir: string;
  /** At-rest encryption key for stored secrets. */
  readonly masterKey?: {
    /** Key file (32 raw bytes / 64 hex / base64). Default `<dataDir>/master.key`; generated on first use. */
    readonly file?: string;
    /**
     * Read `OMNICROSS_MASTER_KEY` before the key file. Default `false`, so a
     * standalone install's env key is never picked up by the embedded host.
     */
    readonly readEnv?: boolean;
  };
  /** The in-process provider proxy CLI children and SDKs connect to. */
  readonly proxy?: {
    /** Loopback host. Default `127.0.0.1`. */
    readonly host?: '127.0.0.1' | '::1' | 'localhost';
    /** Port; `0` (default) picks a free one. */
    readonly port?: number;
  };
  /** Interactive sign-in presentation + test seams. */
  readonly oauth?: {
    /** `<title>` of the loopback callback page shown in the browser. Default `Sign-in`. */
    readonly callbackPageTitle?: string;
    /** Line under the heading on that page. Default `You can close this window.` */
    readonly callbackPageHint?: string;
    /** TEST SEAM: token-exchange / device-poll fetch. Default: proxy-aware upstream fetch. */
    readonly exchangeFetch?: FetchLike;
    /** TEST SEAM: loopback listeners (default: real one-shot listeners on 1455 / 51121). */
    readonly awaitLoopback?: {
      readonly codex?: LoopbackCodeListener;
      readonly antigravity?: LoopbackCodeListener;
    };
  };
  /**
   * CLI launch descriptors for `claude` / `codex` leases: either identifiers
   * for the built-in neutral descriptors, or a full {@link RouteLeaseDescriptorPort}.
   * Default: neutral identifiers (`local-proxy`, `LOCAL_PROXY_ROUTE_TOKEN`).
   */
  readonly routeLeaseDescriptors?: RouteLeaseDescriptorOptions | RouteLeaseDescriptorPort;
  /** Default lease `consumer` (≤64 bytes). Default `host`. */
  readonly leaseConsumer?: string;
  /** Product name used in the few host-visible messages that name one. Default `This app`. */
  readonly productName?: string;
  /** Outbound identity overrides for upstreams that receive one. */
  readonly identity?: {
    /** `user-agent` sent to opencode.ai (default: the library's own). */
    readonly opencodegoUserAgent?: string;
  };
  /** Log sink. Default: discard. The host never writes log files. */
  readonly logger?: Logger;
}

/** Lease request accepted by `leases.create`. */
export interface LeaseRequest {
  readonly runtime: RouteLeaseRuntime;
  /** Where the lease routes: a provider (optionally one key) or a subscription account/group/pool. */
  readonly upstream: RouteLeaseUpstream;
  /** Upstream model id (passthrough; the lease freezes it). */
  readonly model: string;
  /** Required for `runtime: 'endpoint'`; must match the CLI's wire otherwise. */
  readonly wire?: RouteLeaseWire;
  readonly execution?: RouteLeaseExecutionRequest;
  /** 1–3600; default 600. Renew before it lapses. */
  readonly ttlSeconds?: number;
  /** Overrides the host's default consumer for this lease. */
  readonly consumer?: string;
}

/** A live route lease. */
export interface Lease {
  readonly leaseId: string;
  /** False when the idempotency key replayed an existing live lease. */
  readonly created: boolean;
  readonly runtime: RouteLeaseRuntime;
  readonly upstream: RouteLeaseUpstream;
  readonly model: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** CLI launch env + args (`claude`/`codex`); empty for `endpoint`. */
  readonly launch: RuntimeLaunchDescriptor;
  /** In-process connection details (every runtime). */
  readonly endpoint: RouteLeaseEndpoint;
}

/** What `leases.capabilities()` reports. */
export interface LeaseCapabilities {
  readonly runtimes: readonly RouteLeaseRuntime[];
  readonly wires: readonly RouteLeaseWire[];
  readonly upstreamKinds: readonly RouteLeaseUpstream['kind'][];
  readonly maxTtlSeconds: number;
  readonly defaultTtlSeconds: number;
  /** Headers the proxy reads the route token from. */
  readonly tokenHeaders: readonly ['authorization', 'x-api-key', 'x-goog-api-key'];
  /** Subscription providers whose accounts can back a lease. */
  readonly subscriptionProviders: readonly SubscriptionProviderId[];
}

/** One upstream a lease can target, with its declared models. */
export interface UpstreamView {
  /** `providerId` for BYO providers, `sub:<providerId>` for subscription pools. */
  readonly key: string;
  readonly label: string;
  readonly kind: 'provider' | 'subscription';
  readonly target: RouteLeaseUpstream;
  /** Declared models (provider rows: enabled models; pools: the curated catalog). */
  readonly models: readonly string[];
  /** Advisory lease support; `leases.create` runs the authoritative preflight. */
  readonly lease: { readonly supported: boolean; readonly wires: readonly RouteLeaseWire[] };
}

/** Result of `providers.discoverModels`. */
export interface DiscoveredModels {
  readonly models: string[];
  /** Upstream / probe failure text (never a key). */
  readonly error?: string;
  /** Format with no `/models` equivalent (gemini). */
  readonly unsupportedFormat?: boolean;
}

/** Result of `providers.test` (one real, minimal completion — may bill). */
export interface ProviderTestResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly latencyMs?: number;
  readonly sample?: string;
  readonly message?: string;
  readonly unsupportedFormat?: boolean;
}

/** A subscription account as shown to the host (never carries credentials). */
export type AccountView = SubscriptionAccountSanitized & { readonly providerId: SubscriptionProviderId };

/** Result of `accounts.list`. */
export interface AccountList {
  readonly accounts: readonly AccountView[];
  /** Whether a local `claude` / `codex` CLI login exists to import. */
  readonly externalCli: Readonly<Record<'claude' | 'codex', boolean>>;
}

/** Non-secret account metadata patch. */
export interface AccountMetadataPatch {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  /** `null` resets to the provider's default group. */
  readonly group?: string | null;
  readonly tags?: readonly string[];
}

/** Batch account operation (1–100 distinct accounts, all-or-nothing). */
export type AccountBatchRequest = {
  readonly accounts: ReadonlyArray<{ readonly providerId: SubscriptionProviderId; readonly accountId: string }>;
} & (
  | { readonly action: 'enable' | 'disable' | 'delete' }
  | { readonly action: 'set-group'; readonly group: string | null }
);

/** A started interactive sign-in. */
export interface OAuthSession {
  readonly sessionId: string;
  readonly providerId: SubscriptionProviderId;
  readonly kind: OAuthFlowKind;
  /** Authorize / verification URL to open in the user's browser. */
  readonly authUrl: string;
  /** Device-code flows: the code the user enters. */
  readonly userCode?: string;
  /** Device-code flows: where the code is entered (same as `authUrl` unless the provider differs). */
  readonly verificationUri?: string;
  /** Loopback flows: the local callback the browser returns to. */
  readonly callbackUrl?: string;
  /** When the session stops being completable (ISO 8601). */
  readonly expiresAt: string;
}

/** Polled state of a sign-in. */
export interface OAuthStatus {
  readonly state: 'pending' | 'done' | 'error';
  readonly message?: string;
}

/** `health()` snapshot. */
export interface HostHealth {
  /** Proxy listening and the host started. */
  readonly ready: boolean;
  readonly proxyBaseUrl: string | null;
  readonly activeLeases: number;
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly name?: string;
    readonly enabled: boolean;
    readonly modelCount: number;
    readonly keys: { readonly total: number; readonly enabled: number; readonly coolingDown: number; readonly autoDisabled: number };
  }>;
  readonly accounts: ReadonlyArray<{
    readonly providerId: string;
    readonly accountId: string;
    readonly label?: string;
    readonly enabled: boolean;
    readonly schedulable: boolean;
    readonly status: string;
  }>;
}

/** Emitted on `change` after any successful mutation (including async sign-ins). */
export interface HostChangeEvent {
  readonly scope: 'providers' | 'accounts';
  readonly action: string;
  readonly providerId?: string;
}

export type HostChangeListener = (event: HostChangeEvent) => void;
