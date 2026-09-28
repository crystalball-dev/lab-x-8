import { isPowerOfTwo } from '../../util/math';

/**
 * Iterative radix-2 FFT with precomputed twiddle factors and bit-reversal table.
 * Allocation-free after construction, so it is safe to call once per analysis hop.
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly reverse: Uint32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size)) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    const half = size >> 1;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const a = (2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(a);
      this.sinTable[i] = Math.sin(a);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /**
   * Computes the magnitude spectrum of a real signal.
   * @param input  `size` real samples (already windowed by the caller).
   * @param out    receives `size / 2` magnitudes, scaled by `scale`.
   * @param scale  multiplier applied to every magnitude (use it to undo window gain).
   */
  magnitudes(input: Float32Array, out: Float32Array, scale = 1): void {
    const n = this.size;
    const { re, im, reverse, cosTable, sinTable } = this;
    for (let i = 0; i < n; i++) {
      re[reverse[i]!] = input[i]!;
    }
    im.fill(0);

    for (let span = 2; span <= n; span <<= 1) {
      const half = span >> 1;
      const step = n / span;
      for (let start = 0; start < n; start += span) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = start + j;
          const b = a + half;
          const c = cosTable[k]!;
          const s = sinTable[k]!;
          const tr = re[b]! * c + im[b]! * s;
          const ti = im[b]! * c - re[b]! * s;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }

    const bins = n >> 1;
    for (let i = 0; i < bins; i++) {
      out[i] = Math.hypot(re[i]!, im[i]!) * scale;
    }
  }
}
