import { SPECTRUM_BINS, WAVEFORM_SIZE, type AudioFeatures } from '../audio/analysis/features';
import { Texture } from './gl/Texture';

/** Number of past spectra kept for history-based effects. */
export const HISTORY_ROWS = 128;
/** Rows written per second. Fixed, so history scrolls at the same speed at any frame rate. */
export const HISTORY_RATE = 30;

/** Uploads the per-frame audio data that shaders sample: spectrum, waveform and spectrogram. */
export class AudioTextures {
  readonly spectrum: Texture;
  readonly waveform: Texture;
  readonly spectrogram: Texture;
  private row = 0;
  private pending = 0;

  constructor(gl: WebGL2RenderingContext) {
    const r16f = { internalFormat: gl.R16F, format: gl.RED, type: gl.FLOAT };
    this.spectrum = new Texture(gl, r16f);
    this.spectrum.allocate(SPECTRUM_BINS, 1, new Float32Array(SPECTRUM_BINS));
    this.waveform = new Texture(gl, r16f);
    this.waveform.allocate(WAVEFORM_SIZE, 1, new Float32Array(WAVEFORM_SIZE));
    this.spectrogram = new Texture(gl, { ...r16f, wrapT: gl.REPEAT });
    this.spectrogram.allocate(
      SPECTRUM_BINS,
      HISTORY_ROWS,
      new Float32Array(SPECTRUM_BINS * HISTORY_ROWS),
    );
  }

  /** Texture coordinate of the newest spectrogram row. */
  get historyRow(): number {
    return (this.row + 0.5) / HISTORY_ROWS;
  }

  /** Progress towards the next row, in texture coordinates. */
  get historyFraction(): number {
    return this.pending / HISTORY_ROWS;
  }

  update(audio: AudioFeatures, dt: number): void {
    this.spectrum.update(0, 0, SPECTRUM_BINS, 1, audio.spectrum);
    this.waveform.update(0, 0, WAVEFORM_SIZE, 1, audio.waveform);

    this.pending += Math.min(dt, 0.25) * HISTORY_RATE;
    while (this.pending >= 1) {
      this.pending -= 1;
      this.row = (this.row + 1) % HISTORY_ROWS;
      this.spectrogram.update(0, this.row, SPECTRUM_BINS, 1, audio.spectrum);
    }
  }

  reset(): void {
    this.row = 0;
    this.pending = 0;
    this.spectrogram.allocate(
      SPECTRUM_BINS,
      HISTORY_ROWS,
      new Float32Array(SPECTRUM_BINS * HISTORY_ROWS),
    );
  }

  dispose(): void {
    this.spectrum.dispose();
    this.waveform.dispose();
    this.spectrogram.dispose();
  }
}
