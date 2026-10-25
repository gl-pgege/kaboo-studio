import type { Brand } from '../../contract';

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const FONT_STACKS: Record<string, string> = {
  Inter: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
  'System UI': "system-ui, -apple-system, 'Segoe UI', sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  Rounded: "ui-rounded, 'SF Pro Rounded', system-ui, sans-serif",
  Monospace: "ui-monospace, 'SF Mono', Menlo, monospace",
};

const toLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = [1, 3, 5].map(index => toLinear(parseInt(hex.slice(index, index + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l: lightness, c: Math.sqrt(a * a + bb * bb), h: hue < 0 ? hue + 360 : hue };
}

function luminance({ l, c, h }: Oklch): number {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return 0.2126 * clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S) + 0.7152 * clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S) + 0.0722 * clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S);
}

export function contrast(one: Oklch, two: Oklch): number {
  const [light, dark] = [luminance(one), luminance(two)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const format = ({ l, c, h }: Oklch) => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;

function readableOn(background: Oklch, color: Oklch, ratio = 4.5): Oklch {
  const step = background.l > 0.5 ? -0.02 : 0.02;
  let candidate = { ...color };
  while (contrast(candidate, background) < ratio && candidate.l > 0.02 && candidate.l < 0.98) candidate = { ...candidate, l: candidate.l + step };
  return candidate;
}

function setVar(css: string, name: string, value: string): string {
  return css.replace(new RegExp(`(\\n\\s*${name}:\\s*)[^;]+;`), `$1${value};`);
}

export function seedBrand(files: Map<string, Buffer>, brand: Brand, cssEntry: string): Map<string, Buffer> {
  const out = new Map(files);
  const source = files.get(cssEntry)?.toString('utf8');
  if (!source) return out;
  let css = source;
  const DARK_TEXT = { l: 0.18, c: 0.01, h: 60 };
  const LIGHT_TEXT = { l: 0.985, c: 0.004, h: 85 };
  const background = { l: 0.99, c: 0.004, h: 85 };
  if (brand.primary) {
    const primary = hexToOklch(brand.primary);
    const text = contrast(LIGHT_TEXT, primary) >= contrast(DARK_TEXT, primary) ? LIGHT_TEXT : DARK_TEXT;
    css = setVar(css, '--primary', format(primary));
    css = setVar(css, '--primary-hover', format({ ...primary, l: Math.min(0.97, Math.max(0.05, primary.l + (primary.l < 0.5 ? 0.08 : -0.08))) }));
    css = setVar(css, '--primary-foreground', format(text));
    css = setVar(css, '--ring', format({ ...primary, l: Math.min(0.75, Math.max(0.45, primary.l)) }));
  }
  if (brand.accent) {
    const accent = hexToOklch(brand.accent);
    const light = background.l > 0.5;
    css = setVar(css, '--highlight', format(readableOn(background, accent)));
    css = setVar(css, '--accent', format({ l: light ? 0.94 : 0.26, c: Math.min(accent.c, 0.035), h: accent.h }));
    css = setVar(css, '--accent-foreground', format({ l: light ? 0.25 : 0.94, c: Math.min(accent.c, 0.05), h: accent.h }));
  }
  if (brand.headingFont && FONT_STACKS[brand.headingFont]) css = setVar(css, '--font-display', FONT_STACKS[brand.headingFont]);
  if (brand.bodyFont && FONT_STACKS[brand.bodyFont]) css = setVar(css, '--font-sans', FONT_STACKS[brand.bodyFont]);
  if (brand.radius) css = setVar(css, '--radius', `${(parseInt(brand.radius, 10) / 16).toFixed(3).replace(/\.?0+$/, '')}rem`);
  out.set(cssEntry, Buffer.from(css));

  const notes = files.get('DESIGN.md')?.toString('utf8');
  if (notes) {
    const parts = [
      brand.primary && `primary ${brand.primary}`,
      brand.accent && `accent ${brand.accent}`,
      brand.headingFont && `${brand.headingFont} for headings`,
      brand.bodyFont && `${brand.bodyFont} for text`,
      brand.radius && `${brand.radius} corners`,
    ].filter(Boolean);
    if (parts.length) {
      const summary = `Seeded from the store's brand: ${parts.join(', ')}. The tokens are in ${cssEntry}.`;
      out.set('DESIGN.md', Buffer.from(notes.replace(/(## Type and colour\n\n)[^\n]*(\n)/, `$1${summary}$2`)));
    }
  }
  return out;
}
