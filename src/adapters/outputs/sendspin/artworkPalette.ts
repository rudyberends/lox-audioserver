import { intToRGBA, type Jimp } from 'jimp';

/**
 * Derives a color@v1 palette from album artwork, matching the Sendspin spec's
 * WCAG >=4.5:1 contrast invariants for the background/on pairs. The reference
 * server only validates a palette; computing one from the image is the
 * application's job (same split as the visualizer DSP).
 */

export type Rgb = [number, number, number];

export interface ArtworkPalette {
  primary: Rgb;
  accent: Rgb;
  background_dark: Rgb;
  background_light: Rgb;
  on_dark: Rgb;
  on_light: Rgb;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
// Target a little above the 4.5:1 floor so rounding never drops a pair below spec.
const MIN_CONTRAST = 5.0;

const clamp8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB color. */
function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two colors (>=1). */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) {
    const v = clamp8(l * 255);
    return [v, v, v];
  }
  const hue = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [clamp8(hue(p, q, h + 1 / 3) * 255), clamp8(hue(p, q, h) * 255), clamp8(hue(p, q, h - 1 / 3) * 255)];
}

const blend = (a: Rgb, b: Rgb, t: number): Rgb => [
  clamp8(a[0] + (b[0] - a[0]) * t),
  clamp8(a[1] + (b[1] - a[1]) * t),
  clamp8(a[2] + (b[2] - a[2]) * t),
];

/** Darken `rgb` toward black (preserving hue) until it clears `MIN_CONTRAST` vs white. */
function toDarkBackground(rgb: Rgb): Rgb {
  let out = rgb;
  for (let t = 0; t <= 1.001 && contrastRatio(out, WHITE) < MIN_CONTRAST; t += 0.05) {
    out = blend(rgb, BLACK, t);
  }
  return out;
}

/** Lighten `rgb` toward white (preserving hue) until it clears `MIN_CONTRAST` vs black. */
function toLightBackground(rgb: Rgb): Rgb {
  let out = rgb;
  for (let t = 0; t <= 1.001 && contrastRatio(out, BLACK) < MIN_CONTRAST; t += 0.05) {
    out = blend(rgb, WHITE, t);
  }
  return out;
}

/**
 * Pick a vivid, representative color from a small sample of the image: prefer
 * the most saturated pixel at a usable lightness, falling back to the average
 * when the artwork is essentially greyscale.
 */
function pickPrimary(image: Awaited<ReturnType<typeof Jimp.read>>): Rgb {
  const sample = image.clone().resize({ w: 16, h: 16 });
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  let best: Rgb | null = null;
  let bestScore = -1;
  for (let y = 0; y < sample.height; y += 1) {
    for (let x = 0; x < sample.width; x += 1) {
      const { r, g, b, a } = intToRGBA(sample.getPixelColor(x, y));
      if (a < 128) continue;
      rSum += r;
      gSum += g;
      bSum += b;
      count += 1;
      const [, s, l] = rgbToHsl([r, g, b]);
      // Favour saturated mid-tones; penalise near-black/near-white.
      const score = s * (1 - Math.abs(l - 0.5) * 1.4);
      if (score > bestScore) {
        bestScore = score;
        best = [r, g, b];
      }
    }
  }
  if (count === 0) return [128, 128, 128];
  const average: Rgb = [clamp8(rSum / count), clamp8(gSum / count), clamp8(bSum / count)];
  // bestScore near zero => greyscale artwork, the average reads better than a noisy "vivid" pick.
  return bestScore > 0.05 && best ? best : average;
}

/**
 * Pick a second vivid colour that is actually present in the artwork. Keeping
 * it away from the primary hue gives the UI some separation without inventing
 * a complementary colour that may not occur anywhere in the cover.
 */
function pickAccent(image: Awaited<ReturnType<typeof Jimp.read>>, primary: Rgb): Rgb {
  const sample = image.clone().resize({ w: 16, h: 16 });
  const [primaryHue] = rgbToHsl(primary);
  let best: Rgb | null = null;
  let bestScore = -1;

  for (let y = 0; y < sample.height; y += 1) {
    for (let x = 0; x < sample.width; x += 1) {
      const { r, g, b, a } = intToRGBA(sample.getPixelColor(x, y));
      if (a < 128) continue;
      const color: Rgb = [r, g, b];
      const [h, s, l] = rgbToHsl(color);
      if (s < 0.25 || l < 0.12 || l > 0.9) continue;

      const hueDistance = Math.min(Math.abs(h - primaryHue), 1 - Math.abs(h - primaryHue));
      const score = s * (0.5 + hueDistance) * (1 - Math.abs(l - 0.5) * 1.2);
      if (score > bestScore) {
        bestScore = score;
        best = color;
      }
    }
  }

  return best ?? primary;
}

/** Subtly tint `base` (white/black) toward the hue, but only if all required pairs stay >= MIN_CONTRAST. */
function tintedOn(base: Rgb, hue: number, background: Rgb, contrastAgainst: Rgb): Rgb {
  const tint = hslToRgb([hue, 0.5, base === WHITE ? 0.9 : 0.12]);
  if (contrastRatio(tint, background) >= MIN_CONTRAST && contrastRatio(tint, contrastAgainst) >= MIN_CONTRAST) {
    return tint;
  }
  return base;
}

/** Build a full, spec-conformant palette from a decoded artwork image. */
export function derivePalette(image: Awaited<ReturnType<typeof Jimp.read>>): ArtworkPalette {
  const primary = pickPrimary(image);
  const [h, s] = rgbToHsl(primary);
  const accent = pickAccent(image, primary);

  const backgroundDark = toDarkBackground(hslToRgb([h, Math.min(0.6, Math.max(0.25, s)), 0.18]));
  const backgroundLight = toLightBackground(hslToRgb([h, Math.min(0.5, Math.max(0.2, s)), 0.9]));

  const onDark = tintedOn(WHITE, h, backgroundDark, BLACK);
  const onLight = tintedOn(BLACK, h, backgroundLight, WHITE);

  return {
    primary,
    accent,
    background_dark: backgroundDark,
    background_light: backgroundLight,
    on_dark: onDark,
    on_light: onLight,
  };
}
