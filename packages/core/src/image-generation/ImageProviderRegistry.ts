import type { ImageProvider } from './ImageProvider';

export class ImageProviderRegistry {
  readonly #providers = new Map<string, ImageProvider>();

  constructor(providers: readonly ImageProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ImageProvider): void {
    const id = provider.id.trim();
    if (!id) throw new TypeError('Image provider ID must not be empty.');
    if (this.#providers.has(id)) throw new Error(`Duplicate image provider ID: ${id}`);
    this.#providers.set(id, provider);
  }

  resolve(id: string): ImageProvider | undefined {
    return this.#providers.get(id);
  }

  require(id: string): ImageProvider {
    const provider = this.resolve(id);
    if (!provider) throw new Error(`Image provider is not registered: ${id}`);
    return provider;
  }

  list(): readonly ImageProvider[] {
    return [...this.#providers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, provider]) => provider);
  }
}
