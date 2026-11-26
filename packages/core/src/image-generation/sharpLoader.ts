/**
 * Lazy `sharp` loader.
 *
 * `sharp` is a native module (libvips). Every raster decode in the image
 * pipeline runs inside an async function, so it is loaded on first use instead
 * of at module evaluation. That keeps `@omnicross/core` and
 * `@omnicross/subscriptions` importable by hosts that never generate images
 * (for example the embedding entry) without loading the native library.
 *
 * @module @omnicross/core/image-generation/sharpLoader
 */

import type SharpModule from 'sharp';

export type Sharp = typeof SharpModule;

let pending: Promise<Sharp> | undefined;

/** Resolve the `sharp` factory, importing it once per process. */
export function loadSharp(): Promise<Sharp> {
  pending ??= import('sharp').then(
    (mod) => ((mod as { default?: Sharp }).default ?? (mod as unknown as Sharp)),
    (error: unknown) => {
      // Do not cache a failed load: a later call may succeed after an install.
      pending = undefined;
      throw error;
    },
  );
  return pending;
}
