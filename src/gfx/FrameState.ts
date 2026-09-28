import type { AudioFeatures } from '../audio/analysis/features';

/** Everything the renderer needs to know about the frame it is about to draw. */
export interface FrameState {
  /** Seconds since the visuals started. Drives all animation. */
  time: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** Frame counter. */
  frame: number;
  /** Time that runs faster when the music is loud. Gives motion an organic push. */
  audioTime: number;
  audio: AudioFeatures;
}
