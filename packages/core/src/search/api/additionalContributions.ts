import type {
  SearchProvider,
  SearchProviderCapabilities,
  SearchProviderContribution,
} from '@omnicross/contracts/search-types';

import { BochaSearchProvider, BOCHA_CAPABILITIES } from './BochaSearchProvider';
import { BraveSearchProvider, BRAVE_CAPABILITIES } from './BraveSearchProvider';
import { ClaudeSearchProvider, CLAUDE_CAPABILITIES } from './ClaudeSearchProvider';
import { ExaSearchProvider, EXA_CAPABILITIES } from './ExaSearchProvider';
import { FirecrawlSearchProvider, FIRECRAWL_CAPABILITIES } from './FirecrawlSearchProvider';
import { KagiSearchProvider, KAGI_CAPABILITIES } from './KagiSearchProvider';
import { KimiSearchProvider, KIMI_CAPABILITIES } from './KimiSearchProvider';
import { OllamaSearchProvider, OLLAMA_CAPABILITIES } from './OllamaSearchProvider';
import { ParallelSearchProvider, PARALLEL_CAPABILITIES } from './ParallelSearchProvider';
import { PerplexitySearchProvider, PERPLEXITY_CAPABILITIES } from './PerplexitySearchProvider';
import { SyntheticSearchProvider, SYNTHETIC_CAPABILITIES } from './SyntheticSearchProvider';
import { TinyfishSearchProvider, TINYFISH_CAPABILITIES } from './TinyfishSearchProvider';
import type {
  KeyedSearchProviderConfig,
  KeylessSearchProviderConfig,
  SearchApiProviderConfigs,
  SearchApiTransport,
} from './types';

export const KEYLESS_API_PROVIDER_IDS = ['exa', 'parallel', 'firecrawl'] as const;
const KEYED_IDS = [
  'brave', 'kagi', 'kimi', 'synthetic', 'ollama', 'tinyfish', 'perplexity', 'bocha', 'claude',
] as const;

export const ADDITIONAL_API_PROVIDER_IDS = [
  ...KEYLESS_API_PROVIDER_IDS, ...KEYED_IDS,
] as const;

type KeylessId = (typeof KEYLESS_API_PROVIDER_IDS)[number];
type KeyedId = (typeof KEYED_IDS)[number];
type AdditionalId = (typeof ADDITIONAL_API_PROVIDER_IDS)[number];
type ProviderConstructor<Config> = new (
  config: Config,
  transport: SearchApiTransport,
) => SearchProvider;

const KEYLESS_PROVIDERS = {
  exa: ExaSearchProvider,
  parallel: ParallelSearchProvider,
  firecrawl: FirecrawlSearchProvider,
} satisfies Record<KeylessId, ProviderConstructor<KeylessSearchProviderConfig>>;

const KEYED_PROVIDERS = {
  brave: BraveSearchProvider,
  kagi: KagiSearchProvider,
  kimi: KimiSearchProvider,
  synthetic: SyntheticSearchProvider,
  ollama: OllamaSearchProvider,
  tinyfish: TinyfishSearchProvider,
  perplexity: PerplexitySearchProvider,
  bocha: BochaSearchProvider,
  claude: ClaudeSearchProvider,
} satisfies Record<KeyedId, ProviderConstructor<KeyedSearchProviderConfig>>;

/** Public-capable entries describe public mode; registration projects API mode. */
export const ADDITIONAL_API_CAPABILITIES = {
  exa: EXA_CAPABILITIES,
  parallel: PARALLEL_CAPABILITIES,
  firecrawl: FIRECRAWL_CAPABILITIES,
  brave: BRAVE_CAPABILITIES,
  kagi: KAGI_CAPABILITIES,
  kimi: KIMI_CAPABILITIES,
  synthetic: SYNTHETIC_CAPABILITIES,
  ollama: OLLAMA_CAPABILITIES,
  tinyfish: TINYFISH_CAPABILITIES,
  perplexity: PERPLEXITY_CAPABILITIES,
  bocha: BOCHA_CAPABILITIES,
  claude: CLAUDE_CAPABILITIES,
} as const satisfies Record<AdditionalId, Readonly<SearchProviderCapabilities>>;

export function appendAdditionalApiContributions(
  contributions: SearchProviderContribution[],
  configs: SearchApiProviderConfigs,
  transport: SearchApiTransport,
): void {
  for (const id of KEYLESS_API_PROVIDER_IDS) {
    const config = configs[id];
    if (!config) continue;
    const authMode = config.authMode ?? (config.apiKey?.trim() ? 'api' : 'public');
    if (authMode === 'api' && !config.apiKey?.trim()) continue;
    contributions.push({
      id,
      source: 'builtin',
      kind: 'api',
      provider: new KEYLESS_PROVIDERS[id](config, transport),
      capabilities: { ...ADDITIONAL_API_CAPABILITIES[id], requiresApiKey: authMode === 'api' },
    });
  }
  for (const id of KEYED_IDS) {
    const config = configs[id];
    if (!config) continue;
    contributions.push({
      id,
      source: 'builtin',
      kind: 'api',
      provider: new KEYED_PROVIDERS[id](config, transport),
      capabilities: { ...ADDITIONAL_API_CAPABILITIES[id] },
    });
  }
}
