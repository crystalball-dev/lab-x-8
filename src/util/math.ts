/** Small numeric helpers shared across audio and graphics code. */

export const TAU = Math.PI * 2;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * One-pole smoothing coefficient for a step of `dt` seconds and time constant `tau` seconds.
 * `y += (x - y) * smoothingCoef(dt, tau)` is frame-rate independent.
 */
export function smoothingCoef(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Wraps a phase difference into [-0.5, 0.5). */
export function wrapPhase(x: number): number {
  return x - Math.floor(x + 0.5);
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Deterministic 32-bit PRNG (mulberry32). Used wherever reproducible randomness is required. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
