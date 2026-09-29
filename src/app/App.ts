import { AudioEngine, type SourceKind } from '../audio/AudioEngine';
import { BRAND } from '../brand';
import { BrowserSink, type BrowserDestination } from '../export/BrowserSink';
import { FfmpegSink } from '../export/FfmpegSink';
import { LiveRecorder } from '../export/LiveRecorder';
import { exportVideo, sliceBuffer } from '../export/exportVideo';
import type { ExportResult, FrameSink } from '../export/types';
import { GENERATORS } from '../effects/generators';
import { MAX_IMAGE_SIZE, Renderer, type ImageSource } from '../gfx/Renderer';
import { PresetManager } from '../params/presets';
import { createParamStore, parseResolution } from '../params/schema';
import type { PresetData } from '../params/types';
import { publisherLink, wordmark } from '../ui/brand';
import { ExportDialog, type ExportRequest } from '../ui/ExportDialog';
import { Header } from '../ui/Header';
import { Hud, shortGpuName, type HudStats } from '../ui/Hud';
import { Panel } from '../ui/Panel';
import { mountToasts, toast, toastError } from '../ui/toast';
import { debounce } from '../util/async';
import { downloadBlob, h, pickFile } from '../util/dom';
import { createRng } from '../util/math';
import { storage } from '../util/storage';
import { FrameClock } from './FrameClock';
import { FrameStats } from './FrameStats';
import { createTestCard } from './testCard';

/** Named before the product was, and kept, so saved settings carry over. */
const STATE_KEY = 'visualizer.state.v1';
const AUDIO_TYPES = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus';
const IMAGE_TYPES = 'image/*';
/** Parameter groups that Randomize leaves alone. */
const RANDOMIZE_SKIP = new Set(['image', 'output']);

/**
 * Composition root. Owns the long-lived objects, wires them together and runs the frame loop.
 * It contains no DSP, no GL and no widget code of its own.
 */
export class App {
  readonly params = createParamStore();
  readonly presets = new PresetManager(this.params);
  readonly audio = new AudioEngine(this.params);
  renderer: Renderer;

  private readonly clock = new FrameClock(this.params);
  private readonly recorder = new LiveRecorder();
  private readonly hud = new Hud();
  private readonly canvas: HTMLCanvasElement;
  private readonly stage: HTMLElement;
  private readonly side: HTMLElement;
  private readonly startOverlay: HTMLElement;
  private readonly panel: Panel;
  private readonly header: Header;
  private readonly exportDialog: ExportDialog;
  private readonly rng = createRng((Date.now() ^ 0x9e3779b9) >>> 0);

  private image: ImageSource | null = null;
  private exporting = false;
  private contextLost = false;

  private lastTick = 0;
  private lastRender = 0;
  private readonly frameStats = new FrameStats();
  private readonly stats: HudStats = {
    fps: 0,
    frameMs: 0,
    dropped: 0,
    width: 0,
    height: 0,
    renderScale: 1,
    gpu: '',
    source: '',
  };

  constructor(root: HTMLElement) {
    this.restoreState();

    this.canvas = h('canvas', { attrs: { 'aria-label': `${BRAND.name} output` } });
    this.renderer = this.createRenderer();
    this.stats.gpu = shortGpuName(this.renderer.caps.renderer);

    this.startOverlay = h('div', { class: 'start', on: { click: () => this.selectSource('demo') } }, [
      h('div', { class: 'start-card' }, [
        wordmark('wordmark-xl'),
        h('div', { class: 'tagline', text: BRAND.tagline }),
        h('button', { class: 'btn primary start-button', text: 'Start', attrs: { type: 'button' } }),
        h('p', {
          text: 'Starts the built-in demo loop. You can also choose an input in the panel, or drop an audio file or an image here.',
        }),
        h('div', { class: 'credit' }, ['A product of ', publisherLink(BRAND.publisher)]),
      ]),
    ]);
    this.stage = h('div', { class: 'stage' }, [this.canvas, this.hud.element, this.startOverlay]);
    mountToasts(this.stage);

    this.header = new Header(this.audio, this.presets, {
      selectSource: (kind) => this.selectSource(kind),
      openExport: () => void this.exportDialog.show(),
      toggleRecording: () => void this.toggleRecording(),
      toggleFullscreen: () => this.toggleFullscreen(),
      hidePanel: () => this.togglePanel(),
      randomize: () => this.randomize(),
      applyPreset: (id) => this.presets.apply(id),
      savePreset: (name) => {
        const preset = this.presets.save(name);
        this.header.syncPresets(preset.id);
        toast(`Saved preset "${name}"`);
      },
      deletePreset: (id) => {
        this.presets.remove(id);
        this.header.syncPresets('');
      },
      importPreset: () => void this.importPreset(),
      exportPreset: () => this.exportPreset(),
    });
    this.panel = new Panel(this.params, {
      tapTempo: () => this.tapTempo(),
      loadImage: () => void this.pickImage(),
      useTestCard: () => this.setImage({ source: createTestCard(), width: 1920, height: 1080, flipY: true }),
      removeImage: () => this.setImage(null),
      hasImage: () => this.image !== null,
    });
    this.side = h('aside', { class: 'panel' }, [this.header.element, this.panel.element]);
    root.append(this.stage, this.side);

    this.exportDialog = new ExportDialog({
      track: () => {
        const track = this.audio.track;
        return track ? { duration: track.duration, label: this.audio.state.label } : null;
      },
      defaultResolution: () => this.params.str('system.resolution'),
      run: (request, onProgress, signal) => this.runExport(request, onProgress, signal),
    });

    this.applyResolution();
    this.hud.visible = this.params.bool('system.hud');
    const saveState = debounce(() => this.saveState(), 400);
    this.params.subscribe((path) => {
      if (path === '*' || path === 'system.resolution' || path === 'system.renderScale') {
        if (!this.exporting) this.applyResolution();
      }
      if (path === '*' || path === 'system.hud') this.hud.visible = this.params.bool('system.hud');
      saveState();
    });

    this.bindInput();
    requestAnimationFrame(this.tick);
  }

  // --- frame loop --------------------------------------------------------------------------------

  private readonly tick = (now: number): void => {
    requestAnimationFrame(this.tick);
    const interval = now - this.lastTick;
    this.lastTick = now;
    if (this.exporting || this.contextLost) return;

    if (this.lastRender > 0) this.frameStats.refresh(interval);

    const limit = Number(this.params.str('system.fpsLimit'));
    if (limit > 0 && now - this.lastRender < 1000 / limit - 1) return;
    const dt = this.lastRender === 0 ? 1 / 60 : Math.min((now - this.lastRender) / 1000, 0.1);
    this.lastRender = now;

    const begin = performance.now();
    this.audio.update();
    this.renderer.render(this.clock.advance(dt, this.audio.features));
    const cost = performance.now() - begin;

    this.frameStats.frame(now, cost);
    const stats = this.stats;
    stats.fps = this.frameStats.fps;
    stats.frameMs = this.frameStats.frameMs;
    stats.dropped = this.frameStats.dropped;
    stats.source = this.audio.state.kind === 'none' ? 'no audio' : this.audio.state.label;
    this.hud.update(stats, this.audio.features);
    this.panel.tick();
    this.header.tick();
  };

  private createRenderer(): Renderer {
    const renderer = new Renderer(this.canvas, this.params);
    renderer.onShaderError = (message) => {
      // The first lines carry the shader name and the error. The rest is source context.
      toast(message.split(/\r?\n/).slice(0, 3).join(' '), 'error');
    };
    return renderer;
  }

  private applyResolution(): void {
    const { width, height } = parseResolution(this.params.str('system.resolution'));
    const scale = this.params.num('system.renderScale');
    this.renderer.resize(width, height, scale);
    this.stats.width = width;
    this.stats.height = height;
    this.stats.renderScale = scale;
    this.frameStats.reset();
  }

  // --- input sources -----------------------------------------------------------------------------

  private selectSource(kind: Exclude<SourceKind, 'none'>): void {
    const run = async (): Promise<void> => {
      switch (kind) {
        case 'demo':
          await this.audio.useDemo();
          break;
        case 'file': {
          // The picker must open directly from the click, before any awaiting.
          const file = await pickFile(AUDIO_TYPES);
          if (!file) return;
          await this.audio.useFile(file);
          break;
        }
        case 'mic':
          await this.audio.useMicrophone();
          break;
        case 'system':
          await this.audio.useSystemAudio();
          break;
      }
      this.startOverlay.hidden = true;
    };
    run().catch(toastError);
  }

  private tapTempo(): void {
    const bpm = this.audio.tapTempo();
    toast(bpm === null ? 'Bar start set. Keep tapping to set the tempo.' : `${bpm.toFixed(1)} BPM`);
  }

  // --- image -------------------------------------------------------------------------------------

  private setImage(image: ImageSource | null): void {
    this.image = image;
    this.renderer.setImage(image);
    this.panel.rebuild();
  }

  private async pickImage(): Promise<void> {
    const file = await pickFile(IMAGE_TYPES);
    if (file) await this.loadImage(file);
  }

  private async loadImage(file: File): Promise<void> {
    try {
      // Bitmaps ignore the GL flip flag, so the flip is baked in while decoding.
      let bitmap = await createImageBitmap(file, { imageOrientation: 'flipY' });
      const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
      if (scale < 1) {
        const width = Math.round(bitmap.width * scale);
        const height = Math.round(bitmap.height * scale);
        bitmap.close();
        bitmap = await createImageBitmap(file, {
          imageOrientation: 'flipY',
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
        });
      }
      this.setImage({ source: bitmap, width: bitmap.width, height: bitmap.height, flipY: false });
      toast(`Image loaded: ${file.name}`);
    } catch {
      toastError(new Error(`"${file.name}" could not be read as an image.`));
    }
  }

  // --- presets -----------------------------------------------------------------------------------

  private randomize(): void {
    this.params.randomize(this.rng, (_path, group) => !RANDOMIZE_SKIP.has(group.id));
    this.header.syncPresets('');
  }

  private async importPreset(): Promise<void> {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    try {
      const data = this.presets.importJson(await file.text());
      toast(`Loaded "${data.name ?? file.name}"`);
    } catch (error) {
      toastError(error);
    }
  }

  private exportPreset(): void {
    const data: PresetData = { ...this.params.snapshot(), name: `${BRAND.name} preset` };
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `${BRAND.slug}-preset.json`,
    );
  }

  private stepPreset(direction: number): void {
    const all = this.presets.all;
    if (all.length === 0) return;
    this.presetIndex = (this.presetIndex + direction + all.length) % all.length;
    const preset = all[this.presetIndex]!;
    this.presets.apply(preset.id);
    this.header.syncPresets(preset.id);
    toast(preset.name);
  }

  private presetIndex = -1;

  // --- recording and export ----------------------------------------------------------------------

  private async toggleRecording(): Promise<void> {
    if (!LiveRecorder.supported) {
      toastError(new Error('This browser cannot record the canvas.'));
      return;
    }
    if (this.recorder.recording) {
      const result = await this.recorder.stop();
      this.header.recording = false;
      downloadBlob(result.blob, result.fileName);
      toast(`Recorded ${result.seconds.toFixed(1)} s`);
      return;
    }
    const megapixels = (this.renderer.width * this.renderer.height) / 1e6;
    this.recorder.start(this.canvas, 60, megapixels * 16e6, this.audio.monitorNode);
    this.header.recording = true;
    toast('Recording the live output');
  }

  private async runExport(
    request: ExportRequest,
    onProgress: Parameters<ExportDialog['host']['run']>[1],
    signal: AbortSignal,
  ): Promise<ExportResult> {
    const track = this.audio.track;
    if (!track) throw new Error('There is no track to export.');
    const { settings } = request;
    const wasPlaying = this.audio.state.playing;
    this.audio.pause();
    this.exporting = true;

    try {
      let sink: FrameSink;
      if (settings.encoder === 'ffmpeg') {
        const section = settings.includeAudio
          ? sliceBuffer(track, settings.start, settings.duration)
          : null;
        sink = new FfmpegSink(this.renderer.gl, settings, section, request.outputPath);
      } else {
        let destination: BrowserDestination;
        if (request.destination === 'file' && request.fileHandle) {
          destination = { kind: 'file', handle: request.fileHandle };
        } else if (request.destination === 'folder' || request.outputPath) {
          destination = { kind: 'bridge', outputPath: request.outputPath };
        } else {
          destination = { kind: 'memory' };
        }
        sink = new BrowserSink(
          this.canvas,
          settings,
          { sampleRate: track.sampleRate, channels: track.numberOfChannels },
          destination,
        );
      }
      return await exportVideo({
        renderer: this.renderer,
        params: this.params,
        track,
        settings,
        sink,
        signal,
        onProgress,
      });
    } finally {
      this.exporting = false;
      this.applyResolution();
      this.renderer.reset();
      this.lastRender = 0;
      if (wasPlaying) this.audio.play();
    }
  }

  // --- window ------------------------------------------------------------------------------------

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.stage.requestFullscreen().catch(toastError);
  }

  private togglePanel(): void {
    this.side.classList.toggle('hidden');
  }

  private bindInput(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement
          ? target.type === 'text' || target.type === 'number'
          : target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
      if (typing || event.ctrlKey || event.metaKey || event.altKey || this.exportDialog.open) return;

      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        const generator = GENERATORS[Number(digit[1]) - 1];
        if (generator) {
          this.params.set(event.shiftKey ? 'layers.b' : 'layers.a', generator.id.slice(4));
          toast(`${event.shiftKey ? 'Layer B' : 'Layer A'}: ${generator.label}`);
        }
        event.preventDefault();
        return;
      }

      switch (event.code) {
        case 'Space':
          this.audio.toggle();
          break;
        case 'KeyH':
          this.togglePanel();
          break;
        case 'KeyF':
          this.toggleFullscreen();
          break;
        case 'KeyR':
          this.randomize();
          break;
        case 'KeyS':
          this.params.set('system.hud', !this.params.bool('system.hud'));
          break;
        case 'KeyE':
          void this.exportDialog.show();
          break;
        case 'KeyT':
          this.tapTempo();
          break;
        case 'ArrowRight':
          this.stepPreset(1);
          break;
        case 'ArrowLeft':
          this.stepPreset(-1);
          break;
        default:
          return;
      }
      event.preventDefault();
    });

    // Drag and drop of images and audio onto the picture.
    const stage = this.stage;
    stage.addEventListener('dragover', (event) => {
      event.preventDefault();
      stage.classList.add('dragging');
    });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
    stage.addEventListener('drop', (event) => {
      event.preventDefault();
      stage.classList.remove('dragging');
      const file = event.dataTransfer?.files[0];
      if (!file) return;
      if (file.type.startsWith('image/')) {
        void this.loadImage(file);
      } else {
        this.audio
          .useFile(file)
          .then(() => (this.startOverlay.hidden = true))
          .catch(toastError);
      }
    });

    // A lost GPU context (driver reset, sleep) is recovered by rebuilding the renderer.
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      toast('Graphics context lost. Waiting for it to return.', 'error');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.renderer = this.createRenderer();
      this.renderer.setImage(this.image);
      this.applyResolution();
      this.contextLost = false;
      toast('Graphics context restored');
    });
  }

  // --- persistence -------------------------------------------------------------------------------

  private saveState(): void {
    storage.set(STATE_KEY, JSON.stringify(this.params.snapshot({ includeSystem: true })));
  }

  private restoreState(): void {
    try {
      const raw = storage.get(STATE_KEY);
      if (raw) this.params.load(JSON.parse(raw) as PresetData, { includeSystem: true });
    } catch {
      // A corrupt entry is ignored and overwritten on the next change.
    }
  }
}
