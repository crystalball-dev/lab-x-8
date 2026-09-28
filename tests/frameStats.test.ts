import { describe, expect, it } from 'vitest';
import { FrameStats } from '../src/app/FrameStats';

/** Feeds `seconds` of perfectly regular refreshes at `hz`, each drawing one frame. */
function steady(stats: FrameStats, hz: number, seconds: number, start = 1000): number {
  const interval = 1000 / hz;
  let now = start;
  for (let i = 0; i < hz * seconds; i++) {
    now += interval;
    stats.refresh(interval);
    stats.frame(now, 1.5);
  }
  return now;
}

describe('FrameStats', () => {
  for (const hz of [60, 144, 165]) {
    it(`reports ${hz} fps on a steady ${hz} Hz display without drops`, () => {
      const stats = new FrameStats();
      steady(stats, hz, 3);
      expect(stats.fps).toBeGreaterThan(hz * 0.97);
      expect(stats.fps).toBeLessThan(hz * 1.03);
      expect(stats.frameMs).toBeCloseTo(1.5, 5);
      expect(stats.dropped).toBe(0);
    });
  }

  it('counts the refreshes a late frame skipped', () => {
    const stats = new FrameStats();
    const now = steady(stats, 60, 2);
    // One frame arrives after 50 ms instead of 16.7 ms: two refreshes were missed.
    stats.refresh(50);
    stats.frame(now + 50, 1.5);
    expect(stats.dropped).toBe(2);
  });

  it('does not count a pause as dropped frames', () => {
    const stats = new FrameStats();
    steady(stats, 60, 2);
    stats.refresh(4000);
    expect(stats.dropped).toBe(0);
  });

  it('is not thrown off by a burst of closely spaced frames', () => {
    const stats = new FrameStats();
    let now = steady(stats, 60, 2);
    for (let i = 0; i < 5; i++) {
      now += 0.2;
      stats.refresh(0.2);
      stats.frame(now, 1.5);
    }
    now = steady(stats, 60, 2, now);
    expect(stats.fps).toBeGreaterThan(58);
    expect(stats.fps).toBeLessThan(62);
  });
});
