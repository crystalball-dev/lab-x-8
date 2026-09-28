import type { AudioFeatures } from '../audio/analysis/features';
import type { FrameState } from '../gfx/FrameState';
import type { ParamStore } from '../params/ParamStore';
import { computeModSources, createModSources } from '../params/modulation';

/**
 * Advances the visual clock and applies parameter modulation.
 *
 * Live playback calls `advance` with measured frame times, the exporter with a fixed step.
 * Nothing else in the render path reads a clock, which is what makes exports repeatable.
 */
export class FrameClock {
  private time = 0;
  private audioTime = 0;
  private frame = 0;
  private readonly sources = createModSources();

  constructor(private readonly params: ParamStore) {}

  reset(): void {
    this.time = 0;
    this.audioTime = 0;
    this.frame = 0;
  }

  advance(dt: number, audio: AudioFeatures): FrameState {
    const p = this.params;
    const speed = p.num('motion.speed');
    const surge = p.num('motion.surge');
    this.time += dt;
    this.audioTime += dt * speed * (1 + surge * audio.level * audio.level);

    computeModSources(this.sources, audio, this.time);
    p.applyModulation(this.sources);

    return {
      time: this.time,
      dt,
      frame: this.frame++,
      audioTime: this.audioTime,
      audio,
    };
  }

  /** Current modulation source values, for UI meters. */
  get modSources(): Float32Array {
    return this.sources;
  }
}
