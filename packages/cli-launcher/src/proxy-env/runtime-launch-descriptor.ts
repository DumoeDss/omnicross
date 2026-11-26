import {
  RouteLeaseError,
  type RouteLeaseDescriptorPort,
  type RouteLeaseRuntime,
  type RuntimeLaunchDescriptor,
} from '@omnicross/core/provider-proxy';

import { buildClaudeRuntimeLaunchDescriptor } from './claude-proxy-env';
import { buildCodexRuntimeLaunchDescriptor } from './codex-proxy-env';

/** Shared pure descriptor adapter used by RouteLeaseManager and compatibility wrappers. */
export const routeLeaseDescriptorPort: RouteLeaseDescriptorPort = {
  has(runtime: RouteLeaseRuntime): boolean {
    return runtime === 'claude' || runtime === 'codex';
  },
  build(runtime, input): RuntimeLaunchDescriptor {
    switch (runtime) {
      case 'claude':
        return buildClaudeRuntimeLaunchDescriptor(input.proxyBaseUrl, input.model, input.routeToken);
      case 'codex':
        return buildCodexRuntimeLaunchDescriptor(input.proxyBaseUrl, input.routeToken);
      case 'endpoint':
        // In-process leases launch no CLI; the manager never asks for one.
        throw new RouteLeaseError('runtime_unsupported', 'the endpoint runtime has no launch descriptor');
      default: {
        const exhaustive: never = runtime;
        throw new RouteLeaseError('runtime_unsupported', `runtime adapter unavailable: ${String(exhaustive)}`);
      }
    }
  },
};
