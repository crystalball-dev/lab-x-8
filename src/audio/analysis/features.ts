/**
 * The contract between the audio side and the rendering side.
 * Everything a visual effect may react to is described here, and nothing else crosses the boundary.
 */

/** Number of log-spaced bins in the display spectrum (also the spectrum texture width). */
export const SPECTRUM_BINS = 256;
/** Number of samples in the oscilloscope waveform (also the waveform texture width). */
export const WAVEFORM_SIZE = 1024;

/** Range of the selectable tempo. */
export const TEMPO_MIN_BPM = 60;
export const TEMPO_MAX_BPM = 220;
export const DEFAULT_BPM = 174;

export const SPECTRUM_MIN_HZ = 30;
export const SPECTRUM_MAX_HZ = 16000;

export const BANDS = [
  { id: 'sub', label: 'Sub', lo: 25, hi: 60 },
  { id: 'bass', label: 'Bass', lo: 60, hi: 250 },
  { id: 'lowMid', label: 'Low mid', lo: 250, hi: 500 },
  { id: 'mid', label: 'Mid', lo: 500, hi: 2000 },
  { id: 'highMid', label: 'High mid', lo: 2000, hi: 6000 },
  { id: 'high', label: 'High', lo: 6000, hi: 16000 },
] as const;

export const NUM_BANDS = BANDS.length;
export type BandId = (typeof BANDS)[number]['id'];

export interface AudioFeatures {
  /** Stream time in seconds since the analyzer was last reset. */
  time: number;
  /** Overall loudness envelope, roughly 0..1. */
  level: number;
  /** Smoothed per-band energy (sensitivity applied), roughly 0..1 with headroom to 2. */
  bands: Float32Array;
  /** Fast per-band envelope for percussive response. */
  bandsFast: Float32Array;
  /** Decaying impulse fired by any onset. */
  onset: number;
  /** Decaying impulses fired by low, mid and high range onsets. */
  kick: number;
  snare: number;
  hat: number;
  /** Position inside the current beat, 0..1 sawtooth. */
  beatPhase: number;
  /** Exponential pulse restarted on every beat. */
  beatPulse: number;
  /** Beats elapsed on the beat grid. */
  beatCount: number;
  /** Position inside the current bar, 0..1 sawtooth. */
  barPhase: number;
  /** Exponential pulse restarted on the first beat of every bar. */
  barPulse: number;
  /** The tempo the beat clock runs at. */
  bpm: number;
  /** Log-spaced display spectrum, 0..1. */
  spectrum: Float32Array;
  /** Most recent waveform, trigger-aligned, roughly -1..1. */
  waveform: Float32Array;
}

export function createFeatures(): AudioFeatures {
  return {
    time: 0,
    level: 0,
    bands: new Float32Array(NUM_BANDS),
    bandsFast: new Float32Array(NUM_BANDS),
    onset: 0,
    kick: 0,
    snare: 0,
    hat: 0,
    beatPhase: 0,
    beatPulse: 0,
    beatCount: 0,
    barPhase: 0,
    barPulse: 0,
    bpm: 0,
    spectrum: new Float32Array(SPECTRUM_BINS),
    waveform: new Float32Array(WAVEFORM_SIZE),
  };
}

/** User-tunable analysis settings. Changing them never requires rebuilding the analyzer. */
export interface AnalyzerConfig {
  /** Linear input trim applied before analysis. */
  gain: number;
  /** Master multiplier applied to every reactive value. */
  reactivity: number;
  /** Per-band multipliers, one per entry of BANDS. */
  sensitivity: number[];
  /** 0 = snappy, 1 = very smooth. Scales the release time of the band envelopes. */
  smoothing: number;
  /** Automatic gain control: normalizes against the recent peak so quiet and loud sources both work. */
  agc: boolean;
  /** 0..1, higher values detect weaker onsets. */
  onsetSensitivity: number;
  /** Tempo of the beat clock. Set by the user, who knows the music. */
  bpm: number;
  /** Shifts the beat grid, in beats. Positive values make beats arrive earlier. */
  beatOffset: number;
  beatsPerBar: number;
}

export function defaultAnalyzerConfig(): AnalyzerConfig {
  return {
    gain: 1,
    reactivity: 1,
    sensitivity: new Array<number>(NUM_BANDS).fill(1),
    smoothing: 0.35,
    agc: true,
    onsetSensitivity: 0.5,
    bpm: DEFAULT_BPM,
    beatOffset: 0,
    beatsPerBar: 4,
  };
}
