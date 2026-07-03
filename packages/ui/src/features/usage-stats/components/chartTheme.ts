/**
 * chartTheme.ts — resolves the app's theme CSS variables into concrete color
 * strings for Recharts (which needs real values, not Tailwind classes). Reading
 * `getComputedStyle` at render time means the same code reads correctly in both
 * the light `:root` and dark `.dark` palettes. The categorical series palette
 * is derived by rotating hue off the accent token so extra series stay
 * distinguishable while anchored to the brand accent's saturation/lightness.
 */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

/** Parse an `H S% L%` triplet (the shape stored in the theme vars). */
function parseTriplet(triplet: string, fallback: Hsl): Hsl {
  const m = triplet.match(/([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return fallback;
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

function hsl({ h, s, l }: Hsl): string {
  return `hsl(${h} ${s}% ${l}%)`;
}

export interface ChartTheme {
  foreground: string;
  muted: string;
  border: string;
  grid: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  /** Categorical palette for N series/slices (accent-anchored hue rotation). */
  categorical: (count: number) => string[];
}

/** Resolve the current theme's chart colors. Call inside render (DOM present). */
export function getChartTheme(): ChartTheme {
  const fg = parseTriplet(readVar('--text-strong', '47 31% 94%'), { h: 47, s: 31, l: 94 });
  const muted = parseTriplet(readVar('--text-muted', '49 7% 67%'), { h: 49, s: 7, l: 67 });
  const border = parseTriplet(readVar('--line', '40 7% 24%'), { h: 40, s: 7, l: 24 });
  const accent = parseTriplet(readVar('--accent', '15 56% 52%'), { h: 15, s: 56, l: 52 });
  const success = parseTriplet(readVar('--success', '141 61% 44%'), { h: 141, s: 61, l: 44 });
  const warning = parseTriplet(readVar('--warning', '45 93% 47%'), { h: 45, s: 93, l: 47 });
  const danger = parseTriplet(readVar('--danger', '3 58% 62%'), { h: 3, s: 58, l: 62 });

  // Anchor categorical slices to the accent's saturation/lightness, rotate hue
  // by an even step so N slices stay perceptually distinct.
  const categorical = (count: number): string[] => {
    if (count <= 0) return [];
    const step = 360 / Math.max(count, 1);
    return Array.from({ length: count }, (_, i) =>
      hsl({ h: (accent.h + i * step) % 360, s: Math.max(accent.s, 45), l: Math.min(Math.max(accent.l, 45), 62) }),
    );
  };

  return {
    foreground: hsl(fg),
    muted: hsl(muted),
    border: hsl(border),
    grid: hsl({ ...border, l: border.l }),
    accent: hsl(accent),
    success: hsl(success),
    warning: hsl(warning),
    danger: hsl(danger),
    categorical,
  };
}
