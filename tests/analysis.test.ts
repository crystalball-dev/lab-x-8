import { describe, expect, it } from 'vitest';
import { Analyzer } from '../src/audio/analysis/Analyzer';
import { FFT } from '../src/audio/analysis/FFT';
import { HopBuffer } from '../src/audio/analysis/HopBuffer';
import { BANDS, createFeatures } from '../src/audio/analysis/features';
import { createRng } from '../src/util/math';

const SAMPLE_RATE = 48000;

function sine(freq: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return out;
}

/** Synthetic drum loop: a swept-sine kick on every beat and a noise hat on every off-beat. */
function drumLoop(bpm: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const rng = createRng(7);
  const beat = 60 / bpm;
  for (let t = 0; t < seconds; t += beat) {
    const start = Math.round(t * SAMPLE_RATE);
    let phase = 0;
    for (let i = 0; i < SAMPLE_RATE * 0.25 && start + i < out.length; i++) {
      const s = i / SAMPLE_RATE;
      const freq = 50 + 110 * Math.exp(-s / 0.03);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      out[start + i]! += 0.8 * Math.sin(phase) * Math.exp(-s / 0.09);
    }
    const hatStart = Math.round((t + beat / 2) * SAMPLE_RATE);
    let prev = 0;
    for (let i = 0; i < SAMPLE_RATE * 0.05 && hatStart + i < out.length; i++) {
      const white = rng() * 2 - 1;
      const high = white - prev;
      prev = white;
      out[hatStart + i]! += 0.15 * high * Math.exp(-i / SAMPLE_RATE / 0.012);
    }
  }
  return out;
}

function run(analyzer: Analyzer, pcm: Float32Array, chunk = 128, onHop?: () => void): void {
  const hops = new HopBuffer(analyzer.fftSize, analyzer.hopSize);
  for (let i = 0; i < pcm.length; i += chunk) {
    hops.push(pcm.subarray(i, Math.min(pcm.length, i + chunk)), (w) => {
      analyzer.processHop(w);
      onHop?.();
    });
  }
}

describe('FFT', () => {
  it('reports the amplitude of a bin-centred sine', () => {
    const n = 2048;
    const fft = new FFT(n);
    const bin = 64;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      input[i] = 0.5 * Math.sin((2 * Math.PI * bin * i) / n) * hann;
    }
    const mags = new Float32Array(n / 2);
    fft.magnitudes(input, mags, 4 / n);
    expect(mags[bin]).toBeCloseTo(0.5, 3);
    expect(mags[bin + 8]).toBeLessThan(1e-4);
    let peak = 0;
    for (let i = 1; i < mags.length; i++) if (mags[i]! > mags[peak]!) peak = i;
    expect(peak).toBe(bin);
  });

  it('rejects sizes that are not a power of two', () => {
    expect(() => new FFT(1000)).toThrow();
  });
});

describe('Analyzer bands', () => {
  const cases: Array<[number, string]> = [
    [45, 'sub'],
    [120, 'bass'],
    [350, 'lowMid'],
    [1000, 'mid'],
    [4000, 'highMid'],
    [9000, 'high'],
  ];
  for (const [freq, expected] of cases) {
    it(`maps a ${freq} Hz sine to the ${expected} band`, () => {
      const analyzer = new Analyzer(SAMPLE_RATE);
      analyzer.config.agc = false;
      run(analyzer, sine(freq, 1));
      const f = createFeatures();
      analyzer.read(f);
      let best = 0;
      for (let b = 1; b < f.bands.length; b++) if (f.bands[b]! > f.bands[best]!) best = b;
      expect(BANDS[best]!.id).toBe(expected);
      expect(f.bands[best]).toBeGreaterThan(0.2);
    });
  }

  it('decays to silence', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    run(analyzer, sine(120, 1));
    run(analyzer, new Float32Array(SAMPLE_RATE * 3));
    const f = createFeatures();
    analyzer.read(f);
    expect(f.level).toBeLessThan(0.01);
    for (const v of f.bands) expect(v).toBeLessThan(0.01);
    expect(f.kick).toBeLessThan(0.01);
  });

  it('scales with per-band sensitivity', () => {
    const measure = (sensitivity: number): number => {
      const analyzer = new Analyzer(SAMPLE_RATE);
      analyzer.config.sensitivity[1] = sensitivity;
      run(analyzer, sine(120, 1, 0.2));
      const f = createFeatures();
      analyzer.read(f);
      return f.bands[1]!;
    };
    const base = measure(1);
    expect(measure(0.5)).toBeCloseTo(base * 0.5, 2);
    expect(measure(0)).toBe(0);
  });
});

describe('Analyzer onsets', () => {
  it('fires one kick per drum hit and none in between', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    const bpm = 120;
    const seconds = 8;
    const f = createFeatures();
    let kicks = 0;
    let previous = 0;
    run(analyzer, drumLoop(bpm, seconds), 128, () => {
      analyzer.read(f);
      // A rising edge of the kick impulse marks a new onset.
      if (f.kick > previous + 0.2) kicks++;
      previous = f.kick;
    });
    const expected = (seconds * bpm) / 60;
    expect(kicks).toBeGreaterThanOrEqual(expected - 2);
    expect(kicks).toBeLessThanOrEqual(expected + 1);
  });

  it('detects hats separately from kicks', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    const f = createFeatures();
    let hats = 0;
    let previous = 0;
    run(analyzer, drumLoop(120, 8), 128, () => {
      analyzer.read(f);
      if (f.hat > previous + 0.15) hats++;
      previous = f.hat;
    });
    expect(hats).toBeGreaterThanOrEqual(12);
  });

  it('scores the loudest hits near full strength', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    const f = createFeatures();
    let strongest = 0;
    run(analyzer, drumLoop(174, 6), 128, () => {
      analyzer.read(f);
      strongest = Math.max(strongest, f.kick);
    });
    expect(strongest).toBeGreaterThan(0.8);
  });
});

describe('Beat clock', () => {
  it('runs from the transport position at the chosen tempo', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    analyzer.config.bpm = 120;
    const f = createFeatures();

    analyzer.read(f, 0, 1.25);
    expect(f.bpm).toBe(120);
    expect(f.beatCount).toBe(2);
    expect(f.beatPhase).toBeCloseTo(0.5, 6);

    analyzer.read(f, 0, 2.0);
    expect(f.beatCount).toBe(4);
    expect(f.beatPhase).toBeCloseTo(0, 6);
    expect(f.beatPulse).toBeCloseTo(1, 6);
  });

  it('counts bars of the configured length', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    analyzer.config.bpm = 60;
    analyzer.config.beatsPerBar = 4;
    const f = createFeatures();

    analyzer.read(f, 0, 0);
    expect(f.barPhase).toBeCloseTo(0, 6);
    expect(f.barPulse).toBeCloseTo(1, 6);
    analyzer.read(f, 0, 2);
    expect(f.barPhase).toBeCloseTo(0.5, 6);
    analyzer.read(f, 0, 4);
    expect(f.barPhase).toBeCloseTo(0, 6);

    analyzer.config.beatsPerBar = 3;
    analyzer.read(f, 0, 1.5);
    expect(f.barPhase).toBeCloseTo(0.5, 6);
  });

  it('is independent of the music', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    analyzer.config.bpm = 93.5;
    run(analyzer, drumLoop(174, 4));
    const f = createFeatures();
    analyzer.read(f);
    expect(f.bpm).toBe(93.5);
    expect(f.beatPhase).toBeCloseTo(((analyzer.time * 93.5) / 60) % 1, 5);
  });

  it('applies the beat offset', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    analyzer.config.bpm = 60;
    analyzer.config.beatOffset = 0.25;
    const f = createFeatures();
    analyzer.read(f, 0, 3);
    expect(f.beatPhase).toBeCloseTo(0.25, 6);
    expect(f.beatCount).toBe(3);
  });

  it('covers the whole selectable range', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    const f = createFeatures();
    for (const bpm of [60, 87.5, 128, 174, 220]) {
      analyzer.config.bpm = bpm;
      // After exactly eight beats the clock is back on a beat.
      analyzer.read(f, 0, (8 * 60) / bpm);
      expect(f.bpm).toBe(bpm);
      expect(Math.min(f.beatPhase, 1 - f.beatPhase)).toBeLessThan(1e-6);
    }
  });

  it('clamps the tempo to the supported range', () => {
    const analyzer = new Analyzer(SAMPLE_RATE);
    const f = createFeatures();
    analyzer.config.bpm = 20;
    analyzer.read(f, 0, 1);
    expect(f.bpm).toBe(60);
    analyzer.config.bpm = 500;
    analyzer.read(f, 0, 1);
    expect(f.bpm).toBe(220);
  });
});

describe('Determinism', () => {
  it('produces identical features regardless of input block size', () => {
    const pcm = drumLoop(174, 4);
    const a = new Analyzer(SAMPLE_RATE);
    const b = new Analyzer(SAMPLE_RATE);
    run(a, pcm, 128);
    run(b, pcm, 4096);
    const fa = createFeatures();
    const fb = createFeatures();
    a.read(fa);
    b.read(fb);
    expect(fa.time).toBe(fb.time);
    expect(Array.from(fa.bands)).toEqual(Array.from(fb.bands));
    expect(Array.from(fa.spectrum)).toEqual(Array.from(fb.spectrum));
    expect(fa.kick).toBe(fb.kick);
    expect(fa.beatPhase).toBe(fb.beatPhase);
  });
});
