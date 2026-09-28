import type { AudioFeatures } from '../audio/analysis/features';
import { MOD_SOURCES, MOD_SOURCE_INDEX } from './types';

const I = MOD_SOURCE_INDEX;
const LFO_SLOW_HZ = 0.05;
const LFO_FAST_HZ = 0.5;

export function createModSources(): Float32Array {
  return new Float32Array(MOD_SOURCES.length);
}

/** Fills the modulation source vector for one frame. */
export function computeModSources(out: Float32Array, audio: AudioFeatures, time: number): void {
  out[I.none] = 0;
  out[I.level] = audio.level;
  out[I.sub] = audio.bands[0]!;
  out[I.bass] = audio.bands[1]!;
  out[I.lowMid] = audio.bands[2]!;
  out[I.mid] = audio.bands[3]!;
  out[I.highMid] = audio.bands[4]!;
  out[I.high] = audio.bands[5]!;
  out[I.kick] = audio.kick;
  out[I.snare] = audio.snare;
  out[I.hat] = audio.hat;
  out[I.onset] = audio.onset;
  out[I.beat] = audio.beatPulse;
  out[I.beatSaw] = audio.beatPhase;
  out[I.bar] = audio.barPulse;
  out[I.barSaw] = audio.barPhase;
  out[I.lfoSlow] = 0.5 + 0.5 * Math.sin(time * Math.PI * 2 * LFO_SLOW_HZ);
  out[I.lfoFast] = 0.5 + 0.5 * Math.sin(time * Math.PI * 2 * LFO_FAST_HZ);
}
