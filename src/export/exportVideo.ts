import { FrameClock } from '../app/FrameClock';
import type { LookCycler } from '../app/LookCycler';
import { readAnalyzerConfig } from '../audio/AudioEngine';
import { Analyzer } from '../audio/analysis/Analyzer';
import { createFeatures } from '../audio/analysis/features';
import type { Renderer } from '../gfx/Renderer';
import type { ParamStore } from '../params/ParamStore';
import { yieldToBrowser } from '../util/async';
import {
  ExportCancelled,
  type ExportProgress,
  type ExportResult,
  type ExportSettings,
  type FrameSink,
} from './types';

/** Audio analysed before the first frame so gain control and tempo are settled when it starts. */
const PREROLL_SECONDS = 6;
/** Audio is handed to the encoder in chunks of this length, interleaved with the video. */
const AUDIO_CHUNK_SECONDS = 1;
/** How often the loop yields to the browser so the page stays responsive. */
const YIELD_INTERVAL_MS = 50;

export interface ExportJob {
  renderer: Renderer;
  /** Changes looks during the track when the cycle is on. */
  cycler?: LookCycler;
  params: ParamStore;
  track: AudioBuffer;
  settings: ExportSettings;
  sink: FrameSink;
  signal: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

/**
 * Renders a track to video, frame by frame, as fast or as slowly as the machine allows.
 *
 * Nothing here depends on real time. Frame `i` is always drawn from the same audio window with
 * the same clock values, so an export never drops frames and is repeatable, whatever the
 * resolution or the complexity of the look.
 */
export async function exportVideo(job: ExportJob): Promise<ExportResult> {
  const { renderer, params, track, settings, sink, signal } = job;
  const sampleRate = track.sampleRate;
  const mono = mixToMono(track);

  const analyzer = new Analyzer(sampleRate);
  readAnalyzerConfig(params, analyzer.config);
  const features = createFeatures();
  const clock = new FrameClock(params);
  const window = new Float32Array(analyzer.fftSize);

  const { fps } = settings;
  const totalFrames = Math.max(1, Math.round(settings.duration * fps));
  const analysisStart = Math.max(0, settings.start - PREROLL_SECONDS);
  const firstSample = Math.round(analysisStart * sampleRate);
  let hop = 0;

  /** Runs the analyzer up to the given track time. */
  const analyseUntil = (trackTime: number): void => {
    const limit = (trackTime - analysisStart) * sampleRate;
    while ((hop + 1) * analyzer.hopSize <= limit) {
      const end = firstSample + (hop + 1) * analyzer.hopSize;
      fillWindow(window, mono, end);
      analyzer.processHop(window);
      hop++;
    }
  };

  renderer.resize(settings.width, settings.height, 1);
  renderer.reset();
  // The cycle picks its looks from the track position of the first frame, as a seek would.
  job.cycler?.reset();
  analyseUntil(settings.start);

  await sink.start();
  const started = performance.now();
  let lastYield = started;
  let audioSent = 0;

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal.aborted) throw new ExportCancelled();

      // Sample the audio at the middle of the frame's time on screen.
      const trackTime = settings.start + (i + 0.5) / fps;
      analyseUntil(trackTime);
      analyzer.read(features, trackTime - analysisStart, trackTime);

      const frame = clock.advance(1 / fps, features);
      renderer.render(frame, job.cycler?.update(features, clock.modSources) ?? null);
      await sink.addFrame(i / fps, 1 / fps);

      if (settings.includeAudio) {
        const videoTime = (i + 1) / fps;
        while (audioSent < settings.duration && audioSent < videoTime) {
          const length = Math.min(AUDIO_CHUNK_SECONDS, settings.duration - audioSent);
          await sink.addAudio(sliceBuffer(track, settings.start + audioSent, length));
          audioSent += length;
        }
      }

      const now = performance.now();
      const elapsed = (now - started) / 1000;
      job.onProgress?.({
        frame: i + 1,
        totalFrames,
        elapsed,
        speed: (i + 1) / Math.max(elapsed, 1e-3),
      });
      if (now - lastYield > YIELD_INTERVAL_MS) {
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }
    return await sink.finish();
  } catch (error) {
    await sink.cancel().catch(() => undefined);
    throw error;
  }
}

/** Averages all channels into one. */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i]! += data[i]! / channels;
  }
  return out;
}

/** Copies the samples ending at `end` into `window`, zero-padding outside the track. */
function fillWindow(window: Float32Array, pcm: Float32Array, end: number): void {
  const start = end - window.length;
  for (let i = 0; i < window.length; i++) {
    const index = start + i;
    window[i] = index >= 0 && index < pcm.length ? pcm[index]! : 0;
  }
}

/** Extracts a section of a buffer. Reading past the end yields silence. */
export function sliceBuffer(buffer: AudioBuffer, start: number, length: number): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const first = Math.round(start * sampleRate);
  const count = Math.max(1, Math.round(length * sampleRate));
  const out = new AudioBuffer({
    length: count,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const source = buffer.getChannelData(c);
    const available = Math.max(0, Math.min(count, source.length - first));
    if (available > 0) out.copyToChannel(source.subarray(first, first + available), c);
  }
  return out;
}
