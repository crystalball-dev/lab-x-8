import { clamp01, lerp } from '../../util/math';

const HISTORY_SECONDS = 1.0;
/** After a trigger the strength may still be raised for this long while the flux keeps rising. */
const RISE_WINDOW = 0.035;
/** Time constant with which the reference peak forgets old hits, in seconds. */
const PEAK_MEMORY = 5;
/** Below this the reference peak is not trusted, so faint noise cannot fire full-strength hits. */
const MIN_PEAK = 0.12;

/**
 * Adaptive onset detector for one spectral-flux stream.
 *
 * The threshold follows the median of the recent flux. Unlike a mean, the median is not pulled
 * up by the hits themselves, so a busy drum pattern does not deafen the detector.
 * Strength is measured against the strongest recent hit: the loudest drum scores about 1 and a
 * ghost note scores proportionally less.
 *
 * The output is an analytic impulse, strength * exp(-(t - t0) / decay), evaluated at render
 * time. That keeps transients perfectly smooth at any frame rate.
 */
export class OnsetDetector {
  private readonly history: Float32Array;
  private readonly sorted: Float32Array;
  private index = 0;
  private filled = 0;
  private peak = MIN_PEAK;
  private readonly peakDecay: number;
  private lastTime = -Infinity;
  private strength = 0;

  constructor(
    hopDuration: number,
    /** Minimum time between two triggers, in seconds. */
    private readonly refractory: number,
    /** Decay time constant of the output impulse, in seconds. */
    private readonly decay: number,
  ) {
    const size = Math.max(8, Math.round(HISTORY_SECONDS / hopDuration));
    this.history = new Float32Array(size);
    this.sorted = new Float32Array(size);
    this.peakDecay = Math.exp(-hopDuration / PEAK_MEMORY);
  }

  reset(): void {
    this.history.fill(0);
    this.index = 0;
    this.filled = 0;
    this.peak = MIN_PEAK;
    this.lastTime = -Infinity;
    this.strength = 0;
  }

  /**
   * @param flux         novelty value for this hop
   * @param time         stream time of this hop in seconds
   * @param sensitivity  0..1, higher detects weaker onsets
   * @returns true when a new onset fired on this hop
   */
  process(flux: number, time: number, sensitivity: number): boolean {
    const threshold =
      this.median() * lerp(4.5, 1.8, sensitivity) + lerp(0.1, 0.02, sensitivity);

    this.peak = Math.max(flux, this.peak * this.peakDecay, MIN_PEAK);

    let fired = false;
    if (flux > threshold) {
      const relative = clamp01((flux - threshold) / Math.max(this.peak - threshold, 1e-3));
      // The square root lifts medium hits so they still read clearly on screen.
      const candidate = Math.sqrt(relative);
      const since = time - this.lastTime;
      if (since >= this.refractory) {
        if (candidate > this.valueAt(time)) {
          this.strength = candidate;
          this.lastTime = time;
        }
        fired = true;
      } else if (since <= RISE_WINDOW && candidate > this.strength) {
        this.strength = candidate;
      }
    }

    this.history[this.index] = flux;
    this.index = (this.index + 1) % this.history.length;
    if (this.filled < this.history.length) this.filled++;
    return fired;
  }

  valueAt(time: number): number {
    if (this.lastTime === -Infinity) return 0;
    const age = Math.max(0, time - this.lastTime);
    return this.strength * Math.exp(-age / this.decay);
  }

  private median(): number {
    const n = this.filled;
    if (n === 0) return 0;
    const sorted = this.sorted.subarray(0, n);
    sorted.set(this.history.subarray(0, n));
    sorted.sort();
    return sorted[n >> 1]!;
  }
}
