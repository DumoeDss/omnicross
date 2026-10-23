/** Domain directives are local policy, not merely hints sent to an upstream engine. */
export function excludedDomainsFromQuery(query: string): readonly string[] {
  return domainsFromQuery(query, true);
}

/** Used by adapters that additionally support native positive site filters. */
export function domainsFromQuery(query: string, excluded: boolean): string[] {
  const domains = new Set<string>();
  for (const match of query.matchAll(/(?:^|\s)(-?)site:(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi)) {
    if ((match[1] === '-') !== excluded) continue;
    const domain = directiveDomain(match[2] ?? match[3] ?? match[4]);
    if (domain) domains.add(domain);
  }
  return [...domains];
}

/** Both string URLs and already-parsed URLs are accepted; no network lookup is performed. */
export function isExcludedSearchUrl(url: string | URL, excluded: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = canonicalHostname((typeof url === 'string' ? new URL(url) : url).hostname);
  } catch {
    return false;
  }
  return excluded.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function directiveDomain(value: string): string | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    // Path-specific site queries are not domain exclusions and stay upstream directives.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    const domain = canonicalHostname(url.hostname);
    return domain || undefined;
  } catch {
    return undefined;
  }
}

function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}
