import type { RouteContext } from '../provider-proxy/types';

/** Identity comes from the authenticated host route, never from HTTP headers. */
export function imageRouteTenantId(route: RouteContext): string | undefined {
  const value = route.apiKeyId ?? (route.routeLease?.leaseId ? `route-lease:${route.routeLease.leaseId}`
    : route.imageSession?.allowed === true ? route.imageSession.tenantId : undefined);
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value : undefined;
}

export function routeAllowsHostedImages(route: RouteContext): boolean {
  return route.hostedImageGenerationAllowed === true || route.imageSession?.allowed === true;
}
