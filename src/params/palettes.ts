/** Colour palettes. Each is a list of sRGB stops spread evenly over the gradient. */

export interface Palette {
  id: string;
  label: string;
  stops: string[];
}

export const PALETTES: Palette[] = [
  { id: 'neon', label: 'Neon', stops: ['#ff0080', '#7a00ff', '#00e5ff', '#00ff85', '#ffee00'] },
  { id: 'cathode', label: 'Cathode', stops: ['#020a06', '#00ff9c', '#00b3ff', '#ff2bd6', '#fff6d6'] },
  { id: 'acid', label: 'Acid', stops: ['#0b0f00', '#39ff14', '#d4ff00', '#ff00c8', '#1a0033'] },
  { id: 'vapor', label: 'Vapor', stops: ['#2b0a3d', '#ff71ce', '#01cdfe', '#05ffa1', '#b967ff'] },
  { id: 'ultraviolet', label: 'Ultraviolet', stops: ['#05000f', '#3a00ff', '#a600ff', '#ff00aa', '#ffffff'] },
  { id: 'inferno', label: 'Inferno', stops: ['#000004', '#56106e', '#bb3754', '#f98c09', '#fcffa4'] },
  { id: 'sunset', label: 'Sunset', stops: ['#1a0533', '#ff0054', '#ff5400', '#ffbd00', '#390099'] },
  { id: 'toxic', label: 'Toxic', stops: ['#001a00', '#00ff41', '#aaff00', '#00ffd0', '#003322'] },
  { id: 'ice', label: 'Ice', stops: ['#00010a', '#0038ff', '#00c8ff', '#b8fff9', '#ffffff'] },
  { id: 'primaries', label: 'Primaries', stops: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'] },
  { id: 'phosphor', label: 'Green phosphor', stops: ['#000000', '#003b00', '#00a63e', '#33ff66', '#d6ffe0'] },
  { id: 'amber', label: 'Amber phosphor', stops: ['#000000', '#3d1c00', '#b35900', '#ffb000', '#fff1c9'] },
  { id: 'mono', label: 'Monochrome', stops: ['#000000', '#555555', '#aaaaaa', '#ffffff'] },
];

/** Id of the palette built from the four custom colour parameters. */
export const CUSTOM_PALETTE = 'custom';

export const PALETTE_OPTIONS = [
  ...PALETTES.map((p) => ({ value: p.id, label: p.label })),
  { value: CUSTOM_PALETTE, label: 'Custom' },
];

export function findPalette(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id === id);
}

/**
 * Renders gradient stops into RGBA bytes (sRGB encoded).
 * Stops are interpolated in sRGB, which is perceptually more even than linear light.
 */
export function renderPalette(stops: string[], width = 256): Uint8Array {
  const rgb = stops.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  });
  const out = new Uint8Array(width * 4);
  const last = rgb.length - 1;
  for (let i = 0; i < width; i++) {
    const t = last === 0 ? 0 : (i / (width - 1)) * last;
    const k = Math.min(last - 1, Math.floor(t));
    const f = last === 0 ? 0 : t - k;
    const a = rgb[Math.max(0, k)]!;
    const b = rgb[Math.min(last, k + 1)]!;
    out[i * 4] = Math.round(a[0] + (b[0] - a[0]) * f);
    out[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
    out[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}
