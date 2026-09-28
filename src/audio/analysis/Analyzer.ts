import { clamp, clamp01, fract, smoothingCoef } from '../../util/math';
import { FFT } from './FFT';
import { OnsetDetector } from './OnsetDetector';
import {
  BANDS,
  NUM_BANDS,
  SPECTRUM_BINS,
  SPECTRUM_MAX_HZ,
  SPECTRUM_MIN_HZ,
  TEMPO_MAX_BPM,
  TEMPO_MIN_BPM,
  WAVEFORM_SIZE,
  defaultAnalyzerConfig,
  type AnalyzerConfig,
  type AudioFeatures,
} from './features';

/** Target number of analysis hops per second. */
const ANALYSIS_RATE = 96;
/** Log-compression factor applied to magnitudes before spectral flux. */
const FLUX_COMPRESSION = 500;
/** Spectral tilt in dB per octave that compensates the natural roll-off of music. */
const DISPLAY_TILT_DB = 3.5;
const DISPLAY_RANGE_DB = 52;
/** Fixed per-band gains used when automatic gain control is off. */
const FIXED_BAND_GAIN = [2.5, 2.5, 5, 7, 12, 20];
const BAND_PEAK_FLOOR = 2e-3;
const BAND_PEAK_DECAY_SECONDS = 6;
/** Expands band dynamics so sustained material leaves room for transients. */
const BAND_GAMMA = 1.5;

/** Decay times of the beat and bar pulses in seconds. */
const BEAT_PULSE_DECAY = 0.14;
const BAR_PULSE_DECAY = 0.3;
/** Share of the low-range flux that is subtracted from the mid range before snare detection. */
const KICK_BLEED = 0.5;

const KICK_BAND = 1;
const SNARE_BAND = 3;
const HAT_BAND = 5;

interface BinRange {
  lo: number;
  hi: number;
}

/**
 * Converts fixed-hop PCM windows into AudioFeatures.
 *
 * The analyzer is a pure state machine: it never touches Web Audio and never reads a clock.
 * Live playback and offline export feed it the same windows and therefore get the same result.
 */
export class Analyzer {
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly hopSize: number;
  readonly hopDuration: number;
  config: AnalyzerConfig = defaultAnalyzerConfig();

  private readonly fft: FFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly mags: Float32Array;
  private readonly comp: Float32Array;
  private readonly compPrev: Float32Array;

  /** Fractional FFT bin positions bounding each display bin. */
  private readonly displayLo: Float32Array;
  private readonly displayHi: Float32Array;
  private readonly displayTilt: Float32Array;
  private readonly spectrum = new Float32Array(SPECTRUM_BINS);
  private displayCeilDb = -20;

  private readonly bandLo = new Int32Array(NUM_BANDS);
  private readonly bandHi = new Int32Array(NUM_BANDS);
  private readonly bandPeak = new Float32Array(NUM_BANDS).fill(BAND_PEAK_FLOOR);
  private readonly bandEnv = new Float32Array(NUM_BANDS);
  private readonly bandFast = new Float32Array(NUM_BANDS);

  private levelPeak = 0.01;
  private levelEnv = 0;
  private wavePeak = 0.05;
  private readonly waveform = new Float32Array(WAVEFORM_SIZE);

  private readonly fluxAll: BinRange;
  private readonly fluxLow: BinRange;
  private readonly fluxMid: BinRange;
  private readonly fluxHigh: BinRange;
  private readonly onsetAll: OnsetDetector;
  private readonly onsetLow: OnsetDetector;
  private readonly onsetMid: OnsetDetector;
  private readonly onsetHigh: OnsetDetector;

  private hops = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.fftSize = sampleRate > 64000 ? 4096 : 2048;
    this.hopSize = Math.round(sampleRate / ANALYSIS_RATE);
    this.hopDuration = this.hopSize / sampleRate;

    const n = this.fftSize;
    const bins = n >> 1;
    this.fft = new FFT(n);
    this.hann = new Float32Array(n);
    for (let i = 0; i < n; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    this.windowed = new Float32Array(n);
    this.mags = new Float32Array(bins);
    this.comp = new Float32Array(bins);
    this.compPrev = new Float32Array(bins);

    const binHz = sampleRate / n;
    const nyquistBin = bins - 1;
    const maxHz = Math.min(SPECTRUM_MAX_HZ, sampleRate * 0.47);
    const ratio = maxHz / SPECTRUM_MIN_HZ;
    this.displayLo = new Float32Array(SPECTRUM_BINS);
    this.displayHi = new Float32Array(SPECTRUM_BINS);
    this.displayTilt = new Float32Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const fLo = SPECTRUM_MIN_HZ * Math.pow(ratio, i / SPECTRUM_BINS);
      const fHi = SPECTRUM_MIN_HZ * Math.pow(ratio, (i + 1) / SPECTRUM_BINS);
      this.displayLo[i] = Math.min(nyquistBin, fLo / binHz);
      this.displayHi[i] = Math.min(nyquistBin, fHi / binHz);
      this.displayTilt[i] = DISPLAY_TILT_DB * Math.log2(Math.sqrt(fLo * fHi) / 1000);
    }

    const toRange = (loHz: number, hiHz: number): BinRange => {
      const lo = clamp(Math.round(loHz / binHz), 1, nyquistBin);
      const hi = clamp(Math.round(hiHz / binHz), lo + 1, bins);
      return { lo, hi };
    };
    for (let b = 0; b < NUM_BANDS; b++) {
      const range = toRange(BANDS[b]!.lo, BANDS[b]!.hi);
      this.bandLo[b] = range.lo;
      this.bandHi[b] = range.hi;
    }
    this.fluxAll = toRange(30, 16000);
    this.fluxLow = toRange(30, 150);
    this.fluxMid = toRange(200, 4000);
    this.fluxHigh = toRange(6000, 16000);

    const h = this.hopDuration;
    this.onsetAll = new OnsetDetector(h, 0.09, 0.22);
    this.onsetLow = new OnsetDetector(h, 0.12, 0.2);
    this.onsetMid = new OnsetDetector(h, 0.12, 0.16);
    this.onsetHigh = new OnsetDetector(h, 0.05, 0.07);
  }

  /** Stream time of the most recently processed hop, in seconds. */
  get time(): number {
    return this.hops * this.hopDuration;
  }

  reset(): void {
    this.compPrev.fill(0);
    this.spectrum.fill(0);
    this.bandPeak.fill(BAND_PEAK_FLOOR);
    this.bandEnv.fill(0);
    this.bandFast.fill(0);
    this.waveform.fill(0);
    this.levelPeak = 0.01;
    this.levelEnv = 0;
    this.wavePeak = 0.05;
    this.displayCeilDb = -20;
    this.onsetAll.reset();
    this.onsetLow.reset();
    this.onsetMid.reset();
    this.onsetHigh.reset();
    this.hops = 0;
  }

  /** Processes one hop. The window holds the newest fftSize mono samples. */
  processHop(window: Float32Array): void {
    const { config: cfg, fftSize: n, hopSize, hopDuration: h, mags, hann, windowed } = this;
    const gain = cfg.gain;
    this.hops++;
    const time = this.time;

    for (let i = 0; i < n; i++) windowed[i] = window[i]! * gain * hann[i]!;
    // 4 / n undoes the FFT length and the 0.5 coherent gain of the Hann window:
    // a sine of amplitude A lands on magnitude A.
    this.fft.magnitudes(windowed, mags, 4 / n);

    let sumSq = 0;
    let peakAbs = 0;
    for (let i = n - hopSize; i < n; i++) {
      const s = window[i]! * gain;
      sumSq += s * s;
      const a = s < 0 ? -s : s;
      if (a > peakAbs) peakAbs = a;
    }
    const rms = Math.sqrt(sumSq / hopSize);
    const slowDecay = Math.exp(-h / BAND_PEAK_DECAY_SECONDS);
    this.levelPeak = Math.max(rms, this.levelPeak * slowDecay, 0.003);
    this.wavePeak = Math.max(peakAbs, this.wavePeak * Math.exp(-h / 2.5), 0.02);
    const levelRef = cfg.agc ? this.levelPeak : 0.25;
    const levelNow = clamp(Math.pow(rms / levelRef, 1.2) * cfg.reactivity, 0, 2);
    this.levelEnv +=
      (levelNow - this.levelEnv) * smoothingCoef(h, levelNow > this.levelEnv ? 0.02 : 0.3);

    this.updateBands(h, slowDecay);
    this.updateSpectrum(h);
    this.updateOnsets(time);
    this.updateWaveform(window, gain);
  }

  /**
   * Writes the feature snapshot for stream time t into out.
   * Impulses and beat phase are evaluated analytically, so t may lie between two hops.
   *
   * @param transport  position in the track in seconds, when there is one. The beat clock is
   *                   anchored to it, so beats stay put when the track loops or seeks and an
   *                   export shows the same beats as the live playback.
   */
  read(out: AudioFeatures, t: number = this.time, transport: number = t): void {
    const cfg = this.config;
    const s = cfg.sensitivity;
    const react = cfg.reactivity;
    out.time = t;
    out.level = this.levelEnv;
    out.bands.set(this.bandEnv);
    out.bandsFast.set(this.bandFast);
    out.onset = clamp01(this.onsetAll.valueAt(t) * react);
    out.kick = clamp(this.onsetLow.valueAt(t) * react * s[KICK_BAND]!, 0, 1.5);
    out.snare = clamp(this.onsetMid.valueAt(t) * react * s[SNARE_BAND]!, 0, 1.5);
    out.hat = clamp(this.onsetHigh.valueAt(t) * react * s[HAT_BAND]!, 0, 1.5);

    // The beat clock is a pure function of the transport position and the chosen tempo.
    const bpm = clamp(cfg.bpm, TEMPO_MIN_BPM, TEMPO_MAX_BPM);
    const beatSeconds = 60 / bpm;
    const perBar = Math.max(1, Math.round(cfg.beatsPerBar));
    const beats = transport / beatSeconds + cfg.beatOffset;
    const bars = beats / perBar;
    out.bpm = bpm;
    out.beatCount = Math.floor(beats);
    out.beatPhase = fract(beats);
    out.barPhase = fract(bars);
    out.beatPulse = Math.exp((-out.beatPhase * beatSeconds) / BEAT_PULSE_DECAY);
    out.barPulse = Math.exp((-out.barPhase * perBar * beatSeconds) / BAR_PULSE_DECAY);

    out.spectrum.set(this.spectrum);
    out.waveform.set(this.waveform);
  }

  private updateBands(h: number, slowDecay: number): void {
    const { config: cfg, mags, bandPeak, bandEnv, bandFast } = this;
    const releaseSmooth = 0.12 + cfg.smoothing * 0.6;
    const releaseFast = 0.06 + cfg.smoothing * 0.1;
    for (let b = 0; b < NUM_BANDS; b++) {
      let sum = 0;
      for (let k = this.bandLo[b]!; k < this.bandHi[b]!; k++) sum += mags[k]! * mags[k]!;
      const amp = Math.sqrt(sum);

      let value: number;
      if (cfg.agc) {
        const peak = Math.max(amp, bandPeak[b]! * slowDecay, BAND_PEAK_FLOOR);
        bandPeak[b] = peak;
        value = Math.pow(amp / peak, BAND_GAMMA);
      } else {
        value = Math.pow(Math.min(1.5, amp * FIXED_BAND_GAIN[b]!), BAND_GAMMA);
      }
      value = clamp(value * cfg.sensitivity[b]! * cfg.reactivity, 0, 2);

      const env = bandEnv[b]!;
      bandEnv[b] = env + (value - env) * smoothingCoef(h, value > env ? 0.025 : releaseSmooth);
      const fast = bandFast[b]!;
      bandFast[b] = fast + (value - fast) * smoothingCoef(h, value > fast ? 0.004 : releaseFast);
    }
  }

  private updateSpectrum(h: number): void {
    const { config: cfg, mags, spectrum, displayLo, displayHi, displayTilt } = this;
    const attack = smoothingCoef(h, 0.008);
    const release = smoothingCoef(h, 0.06 + cfg.smoothing * 0.25);
    const ceil = cfg.agc ? this.displayCeilDb : -18;
    const floor = ceil - DISPLAY_RANGE_DB;
    const react = Math.min(2, cfg.reactivity);
    let maxDb = -120;

    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const lo = displayLo[i]!;
      const hi = displayHi[i]!;
      const kLo = Math.ceil(lo);
      const kHi = Math.floor(hi);
      let m: number;
      if (kHi < kLo) {
        // The display bin is narrower than one FFT bin: interpolate.
        const c = (lo + hi) * 0.5;
        const k = Math.floor(c);
        const f = c - k;
        m = mags[k]! * (1 - f) + (mags[k + 1] ?? mags[k]!) * f;
      } else {
        m = 0;
        for (let k = kLo; k <= kHi; k++) if (mags[k]! > m) m = mags[k]!;
      }
      const db = 20 * Math.log10(m + 1e-7) + displayTilt[i]!;
      if (db > maxDb) maxDb = db;
      const v = clamp01(((db - floor) / DISPLAY_RANGE_DB) * react);
      const prev = spectrum[i]!;
      spectrum[i] = prev + (v - prev) * (v > prev ? attack : release);
    }

    // The ceiling follows the loudest bin quickly upwards and slowly downwards.
    const target = clamp(maxDb, -55, -6);
    const coef = smoothingCoef(h, target > this.displayCeilDb ? 0.05 : 4);
    this.displayCeilDb += (target - this.displayCeilDb) * coef;
  }

  private updateOnsets(time: number): void {
    const { config: cfg, mags, comp, compPrev } = this;
    const norm = (cfg.agc ? 0.25 / this.levelPeak : 1) * FLUX_COMPRESSION;
    const bins = mags.length;
    for (let k = 0; k < bins; k++) comp[k] = Math.log1p(mags[k]! * norm);

    const flux = (range: BinRange): number => {
      let sum = 0;
      for (let k = range.lo; k < range.hi; k++) {
        const d = comp[k]! - compPrev[k]!;
        if (d > 0) sum += d;
      }
      return sum / (range.hi - range.lo);
    };
    const all = flux(this.fluxAll);
    const low = flux(this.fluxLow);
    const mid = flux(this.fluxMid);
    const high = flux(this.fluxHigh);
    compPrev.set(comp);

    const sens = cfg.onsetSensitivity;
    this.onsetAll.process(all, time, sens);
    this.onsetLow.process(low, time, sens);
    // A kick also splashes into the mids. Discounting the low flux keeps it out of the snare.
    this.onsetMid.process(Math.max(0, mid - KICK_BLEED * low), time, sens);
    this.onsetHigh.process(high, time, sens);
  }

  private updateWaveform(window: Float32Array, gain: number): void {
    const n = this.fftSize;
    const latest = n - WAVEFORM_SIZE;
    // Oscilloscope-style trigger: start on the newest rising zero crossing so the trace holds still.
    let start = latest;
    const searchFloor = Math.max(1, latest - WAVEFORM_SIZE);
    for (let i = latest; i >= searchFloor; i--) {
      if (window[i - 1]! < 0 && window[i]! >= 0) {
        start = i;
        break;
      }
    }
    const scale = this.config.agc ? 0.8 / this.wavePeak : gain;
    const out = this.waveform;
    for (let i = 0; i < WAVEFORM_SIZE; i++) out[i] = window[start + i]! * scale;
  }
}
