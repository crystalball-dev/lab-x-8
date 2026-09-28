import { describe, expect, it } from 'vitest';
import { exportVideo, mixToMono } from '../src/export/exportVideo';
import { ExportCancelled, type ExportSettings, type FrameSink } from '../src/export/types';
import type { FrameState } from '../src/gfx/FrameState';
import type { Renderer } from '../src/gfx/Renderer';
import { createParamStore } from '../src/params/schema';
import { createRng } from '../src/util/math';

const SAMPLE_RATE = 48000;

/** A stand-in for AudioBuffer, which only exists in browsers. */
function createTrack(seconds: number, bpm: number): AudioBuffer {
  const length = Math.round(seconds * SAMPLE_RATE);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const rng = createRng(3);
  const beat = (60 / bpm) * SAMPLE_RATE;
  for (let i = 0; i < length; i++) {
    const t = (i % beat) / SAMPLE_RATE;
    const kick = Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03)) * t) * Math.exp(-t / 0.1);
    const noise = (rng() * 2 - 1) * 0.05;
    left[i] = 0.7 * kick + noise;
    right[i] = 0.7 * kick - noise;
  }
  const channels = [left, right];
  return {
    sampleRate: SAMPLE_RATE,
    length,
    duration: seconds,
    numberOfChannels: 2,
    getChannelData: (c: number) => channels[c]!,
  } as unknown as AudioBuffer;
}

function settings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    start: 0,
    duration: 1,
    encoder: 'browser',
    codec: 'avc',
    bitrate: 40e6,
    includeAudio: false,
    name: 'test',
    ...overrides,
  };
}

interface Run {
  frames: string[];
  timestamps: number[];
  durations: number[];
  size: [number, number] | null;
  resets: number;
  finished: boolean;
  cancelled: boolean;
}

/** Runs an export against a renderer and a sink that only take notes. */
async function record(
  track: AudioBuffer,
  exportSettings: ExportSettings,
  signal: AbortSignal = new AbortController().signal,
  onFrame?: (index: number) => void,
): Promise<Run> {
  const params = createParamStore();
  const watched = params.groups.flatMap((g) =>
    g.params.filter((p) => p.type !== 'color').map((p) => `${g.id}.${p.key}`),
  );
  const run: Run = {
    frames: [],
    timestamps: [],
    durations: [],
    size: null,
    resets: 0,
    finished: false,
    cancelled: false,
  };
  const renderer = {
    resize: (w: number, h: number) => (run.size = [w, h]),
    reset: () => run.resets++,
    render: (state: FrameState) => {
      const a = state.audio;
      // Everything the picture depends on: the frame state and every parameter value.
      run.frames.push(
        JSON.stringify([
          state.time,
          state.dt,
          state.frame,
          state.audioTime,
          a.level,
          a.onset,
          a.kick,
          a.snare,
          a.hat,
          a.beatPhase,
          a.beatCount,
          a.barPhase,
          Array.from(a.bands),
          Array.from(a.spectrum),
          Array.from(a.waveform),
          watched.map((path) => params.num(path)),
        ]),
      );
      onFrame?.(run.frames.length - 1);
    },
  } as unknown as Renderer;
  const sink: FrameSink = {
    start: async () => undefined,
    addFrame: async (timestamp, duration) => {
      run.timestamps.push(timestamp);
      run.durations.push(duration);
    },
    addAudio: async () => undefined,
    finish: async () => {
      run.finished = true;
      return { fileName: 'test.mp4', bytes: 0, location: '' };
    },
    cancel: async () => {
      run.cancelled = true;
    },
  };
  await exportVideo({ renderer, params, track, settings: exportSettings, sink, signal });
  return run;
}

describe('exportVideo', () => {
  const track = createTrack(4, 174);

  it('renders exactly duration times frame rate frames, evenly spaced', async () => {
    for (const fps of [24, 30, 60]) {
      const run = await record(track, settings({ fps, duration: 1.5 }));
      expect(run.frames.length).toBe(Math.round(1.5 * fps));
      expect(run.finished).toBe(true);
      run.timestamps.forEach((t, i) => expect(t).toBeCloseTo(i / fps, 9));
      run.durations.forEach((d) => expect(d).toBeCloseTo(1 / fps, 9));
    }
  });

  it('sets the requested size and starts from a clean state', async () => {
    const run = await record(track, settings({ width: 2560, height: 1440, duration: 0.2 }));
    expect(run.size).toEqual([2560, 1440]);
    expect(run.resets).toBe(1);
  });

  it('feeds identical inputs to every frame on every run', async () => {
    const a = await record(track, settings({ duration: 2 }));
    const b = await record(track, settings({ duration: 2 }));
    expect(a.frames.length).toBe(120);
    expect(a.frames).toEqual(b.frames);
  });

  it('reacts to the audio', async () => {
    const run = await record(track, settings({ duration: 2 }));
    const kicks = run.frames.map((f) => (JSON.parse(f) as number[])[6]!);
    expect(Math.max(...kicks)).toBeGreaterThan(0.6);
    expect(Math.min(...kicks)).toBeLessThan(0.1);
  });

  it('keeps the beat grid anchored to the track when the export starts later', async () => {
    const bpm = 174;
    const params = createParamStore();
    expect(params.num('tempo.bpm')).toBe(bpm);
    const start = 1.0;
    const run = await record(track, settings({ start, duration: 0.5 }));
    const first = JSON.parse(run.frames[0]!) as number[];
    // The first frame samples the middle of its time on screen.
    const beats = ((start + 0.5 / 60) * bpm) / 60;
    expect(first[9]).toBeCloseTo(beats % 1, 6);
    expect(first[10]).toBe(Math.floor(beats));
  });

  it('stops when cancelled and tells the sink to discard its output', async () => {
    const controller = new AbortController();
    let caught: unknown = null;
    let frames = 0;
    try {
      await record(track, settings({ duration: 2 }), controller.signal, (index) => {
        frames = index + 1;
        if (index === 9) controller.abort();
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExportCancelled);
    expect(frames).toBe(10);
  });
});

describe('mixToMono', () => {
  it('averages the channels', () => {
    const mono = mixToMono(createTrack(0.1, 120));
    // The test track carries its noise in opposite phase, so the average is the clean kick.
    const t = 100 / SAMPLE_RATE;
    const kick = Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03)) * t) * Math.exp(-t / 0.1);
    expect(mono[100]).toBeCloseTo(0.7 * kick, 5);
  });
});
