import type { ParamStore } from '../params/ParamStore';
import { desktop } from '../platform/desktop';
import { debounce } from '../util/async';
import { clamp, wrapPhase } from '../util/math';
import { Analyzer } from './analysis/Analyzer';
import { HopBuffer } from './analysis/HopBuffer';
import {
  BANDS,
  TEMPO_MAX_BPM,
  TEMPO_MIN_BPM,
  createFeatures,
  type AnalyzerConfig,
  type AudioFeatures,
} from './analysis/features';
import { renderDemoTrack } from './DemoTrack';
import tapWorkletUrl from './worklet/tap.worklet.ts?worker&url';

export type SourceKind = 'none' | 'demo' | 'file' | 'mic' | 'system';

export interface EngineState {
  kind: SourceKind;
  /** Track name or device description. */
  label: string;
  playing: boolean;
  /** Seconds. Zero for live inputs. */
  duration: number;
  position: number;
}

type Listener = (state: EngineState) => void;

/** Copies the analysis settings out of the parameter store. */
export function readAnalyzerConfig(params: ParamStore, config: AnalyzerConfig): void {
  config.gain = params.num('audio.gain');
  config.reactivity = params.num('audio.reactivity');
  config.smoothing = params.num('audio.smoothing');
  config.onsetSensitivity = params.num('audio.onsets');
  config.agc = params.bool('audio.agc');
  config.bpm = params.num('tempo.bpm');
  config.beatOffset = params.num('tempo.offset');
  config.beatsPerBar = params.num('tempo.beatsPerBar');
  for (let b = 0; b < BANDS.length; b++) config.sensitivity[b] = params.num(`audio.${BANDS[b]!.id}`);
}

/** Taps further apart than this start a new measurement. Just over one beat at 60 BPM. */
const TAP_TIMEOUT_MS = 1300;
const MAX_TAPS = 8;

/**
 * Owns the Web Audio graph and turns whatever is playing into AudioFeatures.
 *
 *   source ──► volume ──► speakers        (tracks only; live inputs are never monitored)
 *        └───► tap worklet ──► main thread ──► HopBuffer ──► Analyzer
 */
export class AudioEngine {
  /** Updated in place by `update()`. */
  readonly features: AudioFeatures = createFeatures();

  private ctx: AudioContext | null = null;
  private tap: AudioWorkletNode | null = null;
  private volume: GainNode | null = null;
  private analyzer: Analyzer | null = null;
  private hops: HopBuffer | null = null;
  private pending: Float32Array[] = [];

  private kind: SourceKind = 'none';
  private label = '';
  private buffer: AudioBuffer | null = null;
  private bufferNode: AudioBufferSourceNode | null = null;
  private streamNode: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private playing = false;
  private startedAt = 0;
  private offset = 0;

  private taps: number[] = [];
  /** Beats tapped since the first tap of the current series. */
  private tapCount = 0;
  private readonly listeners = new Set<Listener>();
  private readonly onHop = (window: Float32Array): void => {
    this.analyzer!.processHop(window);
  };

  constructor(private readonly params: ParamStore) {
    // Re-rendering the demo loop takes a moment, so wait until the slider rests.
    const rebuildDemo = debounce(() => {
      if (this.kind === 'demo') void this.useDemo();
    }, 300);
    params.subscribe((path) => {
      if (path === '*' || path.startsWith('audio.') || path.startsWith('tempo.')) {
        this.applyParams();
      }
      // The demo loop always plays at the chosen tempo.
      if (path === 'tempo.bpm') rebuildDemo();
    });
  }

  /** The decoded track, when the current source is one. Live inputs cannot be exported offline. */
  get track(): AudioBuffer | null {
    return this.kind === 'demo' || this.kind === 'file' ? this.buffer : null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Node carrying the audible signal, for the live recorder. */
  get monitorNode(): AudioNode | null {
    return this.volume;
  }

  get state(): EngineState {
    return {
      kind: this.kind,
      label: this.label,
      playing: this.playing,
      duration: this.buffer && this.track ? this.buffer.duration : 0,
      position: this.position,
    };
  }

  get position(): number {
    if (!this.buffer || !this.ctx) return 0;
    if (!this.playing) return this.offset;
    return (this.ctx.currentTime - this.startedAt + this.offset) % this.buffer.duration;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Creates the audio context. Browsers require this to happen inside a user gesture. */
  async ensureContext(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(tapWorkletUrl);
    const tap = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1 });
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      // Guard against unbounded growth while the tab is hidden and frames are not drawn.
      if (this.pending.length < 400) this.pending.push(event.data);
    };
    // A silent connection to the destination keeps the worklet processing.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    tap.connect(silent).connect(ctx.destination);

    const volume = ctx.createGain();
    volume.connect(ctx.destination);

    this.ctx = ctx;
    this.tap = tap;
    this.volume = volume;
    this.analyzer = new Analyzer(ctx.sampleRate);
    this.hops = new HopBuffer(this.analyzer.fftSize, this.analyzer.hopSize);
    this.applyParams();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  async useDemo(): Promise<void> {
    const ctx = await this.ensureContext();
    // The tempo may change while the loop is being rendered. Render again until it matches.
    let bpm: number;
    let buffer: AudioBuffer;
    do {
      bpm = this.params.num('tempo.bpm');
      buffer = await renderDemoTrack(ctx.sampleRate, bpm);
    } while (bpm !== this.params.num('tempo.bpm'));
    this.setTrack('demo', `Demo loop (${Number(bpm.toFixed(2))} BPM)`, buffer);
  }

  /**
   * Tap tempo. The first tap of a series marks the start of a bar. Tapping on with the beat
   * measures the tempo and keeps the grid on the taps.
   *
   * @returns the measured tempo, or null after a single tap
   */
  tapTempo(now: number = performance.now()): number | null {
    const p = this.params;
    const taps = this.taps;
    if (taps.length > 0 && now - taps[taps.length - 1]! > TAP_TIMEOUT_MS) taps.length = 0;
    taps.push(now);
    if (taps.length > MAX_TAPS) taps.shift();
    this.tapCount = taps.length === 1 ? 0 : this.tapCount + 1;

    let measured: number | null = null;
    if (taps.length >= 2) {
      const interval = (taps[taps.length - 1]! - taps[0]!) / (taps.length - 1);
      measured = clamp(Math.round(600000 / interval) / 10, TEMPO_MIN_BPM, TEMPO_MAX_BPM);
      p.set('tempo.bpm', measured);
    }

    // Put beat number `tapCount` of the bar on this moment.
    const perBar = Math.max(1, p.num('tempo.beatsPerBar'));
    const beats = (this.transport * p.num('tempo.bpm')) / 60;
    p.set('tempo.offset', wrapPhase((this.tapCount - beats) / perBar) * perBar);
    return measured;
  }

  /** Time the beat clock counts from: the track position, or the stream time when live. */
  private get transport(): number {
    if (this.track) return this.position;
    const { analyzer, hops } = this;
    return analyzer && hops ? analyzer.time + hops.pending / analyzer.sampleRate : 0;
  }

  async useFile(file: File): Promise<void> {
    const ctx = await this.ensureContext();
    const data = await file.arrayBuffer();
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(data);
    } catch {
      throw new Error(`"${file.name}" could not be decoded. Try WAV, MP3, FLAC, OGG or M4A.`);
    }
    this.setTrack('file', file.name, buffer);
  }

  async useMicrophone(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await this.setStream('mic', stream.getAudioTracks()[0]?.label || 'Microphone', stream);
  }

  /**
   * Captures what the computer is playing. A browser asks which screen or tab to share.
   * The desktop app captures the system output directly.
   */
  async useSystemAudio(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (stream.getAudioTracks().length === 0) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error(
        desktop
          ? 'System audio capture is not available on this operating system.'
          : 'No audio was shared. Tick "Share audio" in the browser dialog.',
      );
    }
    for (const track of stream.getVideoTracks()) track.stop();
    await this.setStream('system', 'System audio', stream);
  }

  stop(): void {
    this.disconnectSource();
    this.kind = 'none';
    this.label = '';
    this.buffer = null;
    this.emit();
  }

  play(): void {
    if (!this.buffer || !this.ctx || this.playing || !this.track) return;
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.loop = true;
    node.connect(this.volume!);
    node.connect(this.tap!);
    node.start(0, this.offset % this.buffer.duration);
    this.bufferNode = node;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
    this.emit();
  }

  pause(): void {
    if (!this.playing || !this.bufferNode) return;
    this.offset = this.position;
    this.bufferNode.stop();
    this.bufferNode.disconnect();
    this.bufferNode = null;
    this.playing = false;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.offset = Math.max(0, Math.min(seconds, this.buffer.duration - 0.01));
    if (wasPlaying) this.play();
    else this.emit();
  }

  /** Drains the samples that arrived since the last frame and refreshes `features`. */
  update(): void {
    const { analyzer, hops } = this;
    if (!analyzer || !hops) return;
    const pending = this.pending;
    for (let i = 0; i < pending.length; i++) hops.push(pending[i]!, this.onHop);
    pending.length = 0;
    // Evaluate impulses at the true stream position, not at the last hop boundary.
    const now = analyzer.time + hops.pending / analyzer.sampleRate;
    analyzer.read(this.features, now, this.track ? this.position : now);
  }

  private applyParams(): void {
    if (this.analyzer) readAnalyzerConfig(this.params, this.analyzer.config);
    if (this.volume && this.ctx) {
      this.volume.gain.setTargetAtTime(this.params.num('audio.volume'), this.ctx.currentTime, 0.02);
    }
  }

  private setTrack(kind: SourceKind, label: string, buffer: AudioBuffer): void {
    this.disconnectSource();
    this.kind = kind;
    this.label = label;
    this.buffer = buffer;
    this.offset = 0;
    this.play();
    this.emit();
  }

  private async setStream(kind: SourceKind, label: string, stream: MediaStream): Promise<void> {
    const ctx = await this.ensureContext();
    this.disconnectSource();
    this.kind = kind;
    this.label = label;
    this.buffer = null;
    this.stream = stream;
    this.streamNode = ctx.createMediaStreamSource(stream);
    // Live inputs feed the analyzer only. Monitoring a microphone would cause feedback.
    this.streamNode.connect(this.tap!);
    this.playing = true;
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => this.stop();
    this.emit();
  }

  private disconnectSource(): void {
    if (this.bufferNode) {
      try {
        this.bufferNode.stop();
      } catch {
        // Already stopped.
      }
      this.bufferNode.disconnect();
      this.bufferNode = null;
    }
    if (this.streamNode) {
      this.streamNode.disconnect();
      this.streamNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.stream = null;
    }
    this.playing = false;
    this.offset = 0;
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }
}
