/** Length of the measuring window in milliseconds. */
const WINDOW_MS = 500;

/**
 * Frame rate, frame cost and late frames of the live loop.
 *
 * Values are measured over a time window instead of being derived from single frame times,
 * so one irregular frame cannot distort the reading.
 */
export class FrameStats {
  /** Frames drawn per second over the last window. */
  fps = 0;
  /** Mean CPU time spent per frame over the last window, in milliseconds. */
  frameMs = 0;
  /** Display refreshes that arrived late since the last reset. */
  dropped = 0;

  /** Learned display refresh interval in milliseconds. Zero until the first refresh. */
  private refreshInterval = 0;
  private windowStart = 0;
  private windowFrames = 0;
  private windowCost = 0;

  reset(): void {
    this.dropped = 0;
    this.windowStart = 0;
    this.windowFrames = 0;
    this.windowCost = 0;
  }

  /**
   * Call on every display refresh.
   * @param interval  milliseconds since the previous refresh
   */
  refresh(interval: number): void {
    // Pauses, such as a hidden tab, are not frame drops.
    if (!(interval > 1 && interval < 250)) return;
    if (this.refreshInterval === 0) {
      this.refreshInterval = interval;
    } else if (interval < this.refreshInterval * 1.4) {
      this.refreshInterval += (interval - this.refreshInterval) * 0.05;
    } else if (interval > this.refreshInterval * 1.75) {
      this.dropped += Math.round(interval / this.refreshInterval) - 1;
    }
  }

  /**
   * Call after every drawn frame.
   * @param now   timestamp in milliseconds
   * @param cost  CPU time the frame took, in milliseconds
   */
  frame(now: number, cost: number): void {
    if (this.windowStart === 0) this.windowStart = now;
    this.windowFrames++;
    this.windowCost += cost;
    const elapsed = now - this.windowStart;
    if (elapsed >= WINDOW_MS) {
      this.fps = (this.windowFrames * 1000) / elapsed;
      this.frameMs = this.windowCost / this.windowFrames;
      this.windowStart = now;
      this.windowFrames = 0;
      this.windowCost = 0;
    }
  }
}
