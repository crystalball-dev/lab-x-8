/**
 * How far an image layer can reach on screen, so the renderer only redraws that part of the
 * picture: the picture's frame, moved as far as anything in image.frag can push it, plus the
 * reach of its glow and shadow. The constants below mirror the shader. Change them together.
 */

/** Furthest the flowing noise moves the picture, per unit of Warp. */
const WARP = 0.15;
/** Furthest the rings of past bass move it, per unit of Ripple. */
const RIPPLE = 0.078;
/** Furthest the visuals behind push it, per unit of Bend by visuals. */
const DISPLACE = 0.32;
/** Furthest a torn band moves sideways, whenever Glitch is above zero. */
const TEAR = 0.06;
/** The glow and shadow fade by e every this many screen heights outside the picture. */
const HALO_FALLOFF = 0.045;
/**
 * The glow and shadow end where they have faded to this fraction of their strength. There the
 * glow adds less than one step of 8-bit colour even on black, and the shadow takes less.
 */
const HALO_RANGE = 2000;

/** The option indices of the Fit setting. */
const COVER = 0;
const CONTAIN = 1;
const TILE = 3;

/** The settings of an image layer that decide where it draws: effective values, after modulation. */
export interface LayerReach {
  opacity: number;
  /** Index into the Fit options: cover, contain, stretch, tile. */
  fit: number;
  scale: number;
  x: number;
  y: number;
  rotate: number;
  kaleido: number;
  warp: number;
  ripple: number;
  displace: number;
  glitch: number;
  glow: number;
  shadow: number;
}

/** A rectangle of the screen in texture coordinates, 0 to 1 from the bottom left corner. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The part of the screen an image layer can change, or null when all of it is off screen.
 * @param aspect        width over height of the picture
 * @param screenAspect  width over height of the screen
 */
export function imageReach(layer: LayerReach, aspect: number, screenAspect: number): Box | null {
  if (layer.fit === TILE) return { x0: 0, y0: 0, x1: 1, y1: 1 };

  // fittedSize() times the scale: the picture's size in screen heights.
  let width: number;
  let height: number;
  if (layer.fit === COVER || layer.fit === CONTAIN) {
    const wider = aspect > screenAspect;
    const k = layer.fit === COVER ? (wider ? 1 : screenAspect / aspect) : wider ? screenAspect / aspect : 1;
    width = aspect * k;
    height = k;
  } else {
    width = screenAspect;
    height = 1;
  }
  const scale = Math.max(layer.scale, 1e-3);
  width *= scale;
  height *= scale;

  const bend = layer.warp * WARP + layer.ripple * RIPPLE + layer.displace * DISPLACE;
  const dx = bend + (layer.glitch > 0 ? TEAR : 0);
  const dy = bend;
  const strength = Math.max(layer.glow, layer.shadow, 0) * layer.opacity;
  const halo = strength > 0 ? HALO_FALLOFF * Math.log1p(HALO_RANGE * strength) : 0;

  let rx: number;
  let ry: number;
  if (layer.rotate !== 0 || layer.kaleido > 0) {
    // Spinning or mirrored, the picture can point any way: a circle around its centre.
    rx = ry = Math.hypot(width, height) / 2 + halo + Math.hypot(dx, dy);
  } else {
    rx = width / 2 + halo + dx;
    ry = height / 2 + halo + dy;
  }

  const cx = layer.x * 0.5 + 0.5;
  const cy = layer.y * 0.5 + 0.5;
  const box = {
    x0: Math.max(0, cx - rx / screenAspect),
    y0: Math.max(0, cy - ry),
    x1: Math.min(1, cx + rx / screenAspect),
    y1: Math.min(1, cy + ry),
  };
  return box.x0 < box.x1 && box.y0 < box.y1 ? box : null;
}
