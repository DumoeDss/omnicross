/**
 * Daemon search assembly — the one place a `SearchRuntime` is built (plan §6.3).
 *
 * There is exactly ONE runtime per daemon process. It is handed to the Codex
 * route, both managed protocol frontends, the Anthropic `webSearchService` hint
 * slot, and `doctor search`. That is not a convenience: a second runtime is a
 * second provider order, and removing the duplicated fallback implementations
 * is the entire point of the extraction. If a future caller needs "a runtime",
 * it takes this one.
 *
 * Assembly is otherwise deliberately dull — read the validated config, build
 * the contributions it names, apply the egress allowlist and the default
 * policy, and attach a logging listener. No provider selection, no ordering,
 * no fallback logic: all of that lives inside the runtime.
 *
 * @module @omnicross/daemon/search/SearchAssembly
 */

import type {
  SearchPolicy,
  SearchProviderContribution,
  SearchRuntimeEvent,
} from '@omnicross/contracts/search-types';
import type { SearchServerConfig } from '@omnicross/core/outbound-api/types';
import { resolveUpstreamDispatcher } from '@omnicross/core/pipeline/upstreamFetch';
import { createSearchRuntime, type SearchRuntime } from '@omnicross/core/search';
import { apiSearchContributions } from '@omnicross/core/search/api';
import type { SearchEgressPolicy } from '@omnicross/core/search';
import {
  builtinHttpSearchContributions,
  createSearchHttpTransport,
} from '@omnicross/core/search/http';

import type { Logger } from '@omnicross/core';

/** Seams for tests; production passes only the config and a logger. */
export interface SearchAssemblyOptions {
  /** Where runtime events go. Events carry a query HASH, never a query (§11.3). */
  readonly logger?: Pick<Logger, 'debug' | 'warn'> | null;
  /**
   * Override the contribution set entirely (tests). Production leaves this
   * unset so the builtin HTTP pair plus the configured API providers are used.
   */
  readonly contributions?: SearchProviderContribution[];
}

/** The egress policy the configured allowlist produces. */
export function searchEgressPolicyFrom(config: SearchServerConfig): SearchEgressPolicy {
  const hosts = config.egress.allowedPrivateHosts;
  return hosts.length > 0 ? { allowedPrivateHosts: [...hosts] } : {};
}

/** The runtime default policy the configured knobs produce. */
export function searchPolicyFrom(config: SearchServerConfig): SearchPolicy {
  const { preferred, allowed, fallbackEnabled, maxAttempts } = config.policy;
  return {
    ...(preferred !== undefined ? { preferred } : {}),
    ...(allowed !== undefined ? { allowed: [...allowed] } : {}),
    fallbackEnabled,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
}

/**
 * Route search egress through the SAME layered proxy stack as LLM upstream
 * traffic (`fetchUpstream`: account > provider > server.proxy > env). The
 * resolver's loopback/`NO_PROXY` verdicts apply per URL, and a config edit
 * hot-reloads through its dispatcher generation bump. With no resolver
 * registered (CLI/standalone use of core) or no layer matching the target, the
 * transports' env layer applies unchanged — the Elftia baseline.
 */
export function resolveSearchUpstreamDispatcher(
  url: string,
): ReturnType<typeof resolveUpstreamDispatcher> {
  return resolveUpstreamDispatcher({ url });
}

/**
 * Every contribution the config asks for: the two keyless HTTP engines, plus
 * exactly the API providers that are configured.
 *
 * Configured-only gating is preserved verbatim from 阶段4 — an unconfigured
 * provider produces no contribution, so discovery never advertises something
 * that cannot run, and the fallback walk never burns an attempt finding out.
 */
export function searchContributionsFrom(
  config: SearchServerConfig,
): SearchProviderContribution[] {
  return [
    ...builtinHttpSearchContributions(
      createSearchHttpTransport({ resolveProxyDispatcher: resolveSearchUpstreamDispatcher }),
    ),
    ...apiSearchContributions(config.providers, {
      egressPolicy: searchEgressPolicyFrom(config),
      resolveProxyDispatcher: resolveSearchUpstreamDispatcher,
    }),
  ];
}

/**
 * Build the daemon's single search runtime.
 *
 * The event listener logs at DEBUG because these fire on every search. They are
 * safe to log by construction: `SearchRuntimeEvent` has no field for query
 * text, a URL, or result content — only a one-way query hash (plan §11.3).
 */
export function buildSearchRuntime(
  config: SearchServerConfig,
  options: SearchAssemblyOptions = {},
): SearchRuntime {
  const logger = options.logger ?? null;
  return createSearchRuntime({
    contributions: options.contributions ?? searchContributionsFrom(config),
    policy: searchPolicyFrom(config),
    ...(logger
      ? {
          onEvent: (event: SearchRuntimeEvent): void => {
            logger.debug(`[search] ${formatSearchEvent(event)}`);
          },
        }
      : {}),
  });
}

/** One event as a flat, secret-free log line. */
export function formatSearchEvent(event: SearchRuntimeEvent): string {
  const parts = [
    `type=${event.type}`,
    `request=${event.requestId}`,
    `queryHash=${event.queryHash}`,
    `durationMs=${event.durationMs}`,
  ];
  if ('providerId' in event && event.providerId !== undefined) {
    parts.push(`provider=${event.providerId}`);
  }
  if ('outcome' in event && event.outcome !== undefined) parts.push(`outcome=${event.outcome}`);
  if ('errorCode' in event && event.errorCode !== undefined) parts.push(`error=${event.errorCode}`);
  if ('resultCount' in event && event.resultCount !== undefined) {
    parts.push(`results=${event.resultCount}`);
  }
  if ('fallbackCount' in event && event.fallbackCount !== undefined) {
    parts.push(`fallbacks=${event.fallbackCount}`);
  }
  return parts.join(' ');
}
