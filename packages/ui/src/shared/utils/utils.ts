/**
 * cn — className combiner (ported from the upstream `@/shared/utils/utils`).
 *
 * A dependency-free clsx-style combiner: filters falsy values and joins with a
 * space. The Provider page only passes strings / conditional strings, so the
 * minimal form is sufficient (no tailwind-merge dedupe needed).
 */
export type ClassValue = string | number | null | false | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue): void => {
    if (!v && v !== 0) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === 'string' || typeof v === 'number') {
      out.push(String(v));
    }
  };
  inputs.forEach(walk);
  return out.join(' ');
}
