/**
 * Turns an arbitrary stream of sample blocks into fixed-hop analysis windows.
 * Every `hopSize` samples it hands the most recent `windowSize` samples to the callback.
 */
export class HopBuffer {
  private readonly ring: Float32Array;
  private readonly linear: Float32Array;
  private write = 0;
  private sinceHop = 0;

  constructor(
    readonly windowSize: number,
    readonly hopSize: number,
  ) {
    this.ring = new Float32Array(windowSize);
    this.linear = new Float32Array(windowSize);
  }

  /** Samples received since the last emitted window. */
  get pending(): number {
    return this.sinceHop;
  }

  reset(): void {
    this.ring.fill(0);
    this.write = 0;
    this.sinceHop = 0;
  }

  push(samples: Float32Array, onWindow: (window: Float32Array) => void): void {
    const { ring, windowSize, hopSize } = this;
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(hopSize - this.sinceHop, samples.length - offset);
      const firstPart = Math.min(take, windowSize - this.write);
      ring.set(samples.subarray(offset, offset + firstPart), this.write);
      if (firstPart < take) ring.set(samples.subarray(offset + firstPart, offset + take), 0);
      this.write = (this.write + take) % windowSize;
      this.sinceHop += take;
      offset += take;
      if (this.sinceHop === hopSize) {
        this.sinceHop = 0;
        this.emit(onWindow);
      }
    }
  }

  /** Feeds `count` zero samples. Used to let envelopes decay when a live stream stalls. */
  pushSilence(count: number, onWindow: (window: Float32Array) => void): void {
    const block = SILENCE.length;
    let remaining = count;
    while (remaining > 0) {
      const n = Math.min(block, remaining);
      this.push(n === block ? SILENCE : SILENCE.subarray(0, n), onWindow);
      remaining -= n;
    }
  }

  private emit(onWindow: (window: Float32Array) => void): void {
    const { ring, linear, windowSize, write } = this;
    linear.set(ring.subarray(write, windowSize), 0);
    linear.set(ring.subarray(0, write), windowSize - write);
    onWindow(linear);
  }
}

const SILENCE = new Float32Array(1024);
