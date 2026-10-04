import { AudioEngine, type SourceKind } from '../audio/AudioEngine';
import { BRAND } from '../brand';
import { BrowserSink, type BrowserDestination } from '../export/BrowserSink';
import { FfmpegSink } from '../export/FfmpegSink';
import { LiveRecorder } from '../export/LiveRecorder';
import { exportVideo, sliceBuffer } from '../export/exportVideo';
import type { ExportResult, FrameSink } from '../export/types';
import { GENERATORS } from '../effects/generators';
import { IMAGE_LAYERS } from '../effects/stages';
import { Renderer, type ImageSource } from '../gfx/Renderer';
import { PresetManager, upgradePreset } from '../params/presets';
import { createParamStore, outputSize, randomizeLook } from '../params/schema';
import type { PresetData, PresetPicture } from '../params/types';
import { publisherLink, wordmark } from '../ui/brand';
import { ExportDialog, type ExportRequest } from '../ui/ExportDialog';
import { Header } from '../ui/Header';
import { Hud, shortGpuName, type HudStats } from '../ui/Hud';
import { Panel, type LayerPicture } from '../ui/Panel';
import { mountToasts, toast, toastError } from '../ui/toast';
import { debounce } from '../util/async';
import { fromBase64, toBase64 } from '../util/base64';
import { downloadBlob, h, pickFile, pickFiles } from '../util/dom';
import { createRng } from '../util/math';
import { storage } from '../util/storage';
import { FrameClock } from './FrameClock';
import { FrameStats } from './FrameStats';
import { LookCycler } from './LookCycler';
import { createPictureStore } from './pictureStore';
import { decodePicture, thumbnail } from './pictures';
import { createTestCard } from './testCard';

const STATE_KEY = 'lab-x-8.state.v1';
const AUDIO_TYPES = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus';
/** Settings that change the size of the picture. */
const SIZE_SETTINGS = new Set(['system.resolution', 'system.width', 'system.height', 'system.renderScale']);
const IMAGE_TYPES = 'image/*';

/** Stands for the generated test card where a kept picture's id would be. */
const TEST_CARD = 'test-card';

/** A picture in an image layer. */
interface LoadedPicture extends LayerPicture {
  /** Its kept copy, TEST_CARD for the test card, or null when it could not be kept. */
  id: string | null;
}

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
  private readonly cycler = new LookCycler(this.params, this.presets, (preset) => {
    this.header.syncPresets(preset?.id ?? '');
  });
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

  /** The picture in each image layer, or null for an empty layer. */
  private readonly pictures: Array<LoadedPicture | null> = IMAGE_LAYERS.map(() => null);
  /** Changes whenever a picture is loaded, removed or moved. */
  private pictureRevision = 0;
  /** Copies of the pictures, so presets and the next session can bring them back. */
  private readonly store = createPictureStore();
  /** Settles once the kept pictures have been tidied at startup. Keeping new ones waits for it. */
  private storeReady: Promise<void> = Promise.resolve();
  /** Changes with every new set of pictures, so a set still loading gives way to a newer one. */
  private pictureGeneration = 0;
  private readonly saveSoon = debounce(() => this.saveState(), 400);
  private appliedResolution = '';
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
    const restored = this.restoreState();

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
      applyPreset: (id) => this.applyPreset(id),
      savePreset: (name) => this.savePreset(name),
      deletePreset: (id) => {
        this.presets.remove(id);
        this.header.syncPresets('');
      },
      importPreset: () => void this.importPreset(),
      exportPreset: () => void this.exportPreset().catch(toastError),
    });
    this.panel = new Panel(this.params, {
      tapTempo: () => this.tapTempo(),
      loadImage: (layer) => void this.pickImage(layer),
      addImages: () => void this.pickImages(),
      dropImages: (files, layer) => void this.dropImages(files, layer),
      useTestCard: (layer) => this.useTestCard(layer),
      removeImage: (layer) => this.setPicture(layer, null, null),
      clearImages: () => this.clearPictures(),
      moveLayer: (from, to) => this.moveLayer(from, to),
      duplicateLayer: (layer) => void this.duplicateLayer(layer),
      picture: (layer) => this.pictures[layer] ?? null,
      pictureRevision: () => this.pictureRevision,
      cycleStatus: () => this.cycler.describe(),
    });
    this.side = h('aside', { class: 'panel' }, [this.header.element, this.panel.element]);
    root.append(this.stage, this.side);

    this.exportDialog = new ExportDialog({
      track: () => {
        const track = this.audio.track;
        return track ? { duration: track.duration, label: this.audio.state.label } : null;
      },
      outputSize: () => outputSize(this.params),
      run: (request, onProgress, signal) => this.runExport(request, onProgress, signal),
    });

    this.applyResolution();
    this.hud.visible = this.params.bool('system.hud');
    this.params.subscribe((path) => {
      if (path === '*' || SIZE_SETTINGS.has(path)) {
        if (!this.exporting) this.applyResolution(false);
      }
      if (path === '*' || path === 'system.hud') this.hud.visible = this.params.bool('system.hud');
      this.saveSoon();
    });

    this.bindInput();
    requestAnimationFrame(this.tick);
    void this.startPictures(restored.state, restored.intact);
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
    const frame = this.clock.advance(dt, this.audio.features);
    this.renderer.render(frame, this.cycler.update(this.audio.features, this.clock.modSources));
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

  /** Sizes the renderer for the chosen resolution. Unless forced, only when that changed. */
  private applyResolution(force = true): void {
    const { width, height } = outputSize(this.params);
    const scale = this.params.num('system.renderScale');
    // Every preset load reports a change. Skipping those keeps the frame statistics running.
    if (!force && `${width}x${height}@${scale}` === this.appliedResolution) return;
    this.appliedResolution = `${width}x${height}@${scale}`;
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

  /** Puts a picture into an image layer, or empties the layer. */
  private setPicture(layer: number, picture: LoadedPicture | null, image: ImageSource | null): void {
    this.pictures[layer] = picture;
    this.pictureRevision++;
    this.renderer.setImage(layer, image);
    this.panel.rebuild();
    this.saveSoon();
  }

  private useTestCard(layer: number): void {
    const card = createTestCard();
    this.setPicture(
      layer,
      { name: 'Test card', thumbnail: thumbnail(card, card.width, card.height, false), id: TEST_CARD },
      { source: card, width: card.width, height: card.height, flipY: true },
    );
  }

  private clearPictures(): void {
    this.pictures.forEach((picture, layer) => {
      if (picture) this.setPicture(layer, null, null);
    });
  }

  /**
   * Moves an image layer to another place in the drawing order, its picture and settings
   * together. The layers in between move one place towards where it was.
   */
  private moveLayer(from: number, to: number): void {
    const step = Math.sign(to - from);
    for (let i = from; i !== to; i += step) {
      const j = i + step;
      const picture = this.pictures[i] ?? null;
      this.pictures[i] = this.pictures[j] ?? null;
      this.pictures[j] = picture;
      this.renderer.swapImages(i, j);
      this.params.swapGroups(IMAGE_LAYERS[i]!.id, IMAGE_LAYERS[j]!.id);
    }
    this.pictureRevision++;
    this.panel.showImageLayer(to);
    this.saveSoon();
  }

  /** Puts a copy of an image layer directly above it: the same picture, with the same settings. */
  private async duplicateLayer(layer: number): Promise<void> {
    const picture = this.pictures[layer];
    if (!picture) return;
    // Make room right above it, from the nearest empty layer above, or else below.
    const empty = this.pictures.flatMap((other, i) => (other ? [] : [i]));
    const above = empty.find((i) => i > layer);
    const below = empty.filter((i) => i < layer).at(-1);
    let original = layer;
    if (above !== undefined) {
      this.moveLayer(above, layer + 1);
    } else if (below !== undefined) {
      this.moveLayer(below, layer);
      original = layer - 1;
    } else {
      toast(`All ${IMAGE_LAYERS.length} image layers are in use.`);
      return;
    }
    const copy = original + 1;
    if (!(await this.loadKept(picture, copy))) {
      toastError(new Error(`"${picture.name}" could not be copied.`));
      return;
    }
    this.params.copyGroup(IMAGE_LAYERS[original]!.id, IMAGE_LAYERS[copy]!.id);
    this.panel.showImageLayer(copy);
    toast(`Image ${copy + 1}: a copy of image ${original + 1}`);
  }

  private async pickImage(layer: number): Promise<void> {
    const file = await pickFile(IMAGE_TYPES);
    if (!file) return;
    if (await this.loadImage(file, layer)) toast(`Image ${layer + 1}: ${file.name}`);
    else toastError(new Error(`"${file.name}" could not be read as an image.`));
  }

  private async pickImages(): Promise<void> {
    const files = await pickFiles(IMAGE_TYPES);
    if (files.length > 0) await this.addImages(files);
  }

  /**
   * Puts pictures into the empty image layers in turn, and shows the first in the panel. With
   * every layer taken, the first replaces the picture of the layer shown in the panel.
   */
  private async addImages(files: File[]): Promise<void> {
    const empty = this.pictures.flatMap((picture, layer) => (picture ? [] : [layer]));
    const layers = empty.length > 0 ? empty : [this.panel.imageLayer];
    const fitting = files.slice(0, layers.length);
    const loaded: number[] = [];
    const failed: string[] = [];
    for (const [i, file] of fitting.entries()) {
      if (await this.loadImage(file, layers[i]!)) loaded.push(layers[i]!);
      else failed.push(file.name);
    }

    const first = loaded[0];
    if (first !== undefined) {
      this.panel.showImageLayer(first);
      toast(
        loaded.length === 1
          ? `Image ${first + 1}: ${this.pictures[first]!.name}`
          : `${loaded.length} pictures, in image layers ${first + 1} to ${loaded.at(-1)! + 1}`,
      );
    }
    const left = files.length - fitting.length;
    if (left > 0) {
      toast(`${left} more picture${left === 1 ? '' : 's'} did not fit. All ${IMAGE_LAYERS.length} image layers are in use.`);
    }
    if (failed.length > 0) {
      const more = failed.length > 1 ? ` and ${failed.length - 1} more` : '';
      toastError(new Error(`"${failed[0]}"${more} could not be read as ${more ? 'images' : 'an image'}.`));
    }
  }

  /** Pictures dropped on an image layer in the panel: the first goes into it, the rest into empty layers. */
  private async dropImages(files: File[], layer: number): Promise<void> {
    const [first, ...rest] = files;
    if (!first) return;
    if (await this.loadImage(first, layer)) toast(`Image ${layer + 1}: ${first.name}`);
    else toastError(new Error(`"${first.name}" could not be read as an image.`));
    if (rest.length > 0) await this.addImages(rest);
    this.panel.showImageLayer(layer);
  }

  /**
   * Loads a picture file into an image layer, and keeps a copy of it, so presets and the next
   * session can bring it back. Returns false when it cannot be read.
   */
  private async loadImage(file: File, layer: number): Promise<boolean> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodePicture(file);
    } catch {
      return false;
    }
    const id = await this.keep(file);
    if (!id) toastError(new Error(`"${file.name}" could not be kept, so presets will not bring it back.`));
    const { width, height } = bitmap;
    this.setPicture(
      layer,
      { name: file.name, thumbnail: thumbnail(bitmap, width, height, true), id },
      { source: bitmap, width, height, flipY: false },
    );
    // The graphics card has its own copy now.
    bitmap.close();
    return true;
  }

  /** Keeps a copy of a picture file. Resolves with its id, or null when it could not be kept. */
  private async keep(file: Blob): Promise<string | null> {
    await this.storeReady;
    return this.store.put(file).catch(() => null);
  }

  /**
   * Loads a kept picture into an image layer. Returns false when it is no longer kept.
   * @param still  checked once the picture is read, so a newer choice of pictures wins
   */
  private async loadKept(picture: PresetPicture | LoadedPicture, layer: number, still = (): boolean => true): Promise<boolean> {
    if (picture.id === TEST_CARD) {
      if (still()) this.useTestCard(layer);
      return true;
    }
    if (!picture.id) return false;
    const blob = await this.store.get(picture.id).catch(() => null);
    if (!blob) return false;
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodePicture(blob);
    } catch {
      return false;
    }
    if (still()) {
      const { width, height } = bitmap;
      this.setPicture(
        layer,
        { name: picture.name, thumbnail: thumbnail(bitmap, width, height, true), id: picture.id },
        { source: bitmap, width, height, flipY: false },
      );
    }
    bitmap.close();
    return true;
  }

  /**
   * Puts a set of pictures on screen, as a preset or the last session had them: each in its
   * layer, the other layers emptied. A layer that already shows the right picture keeps it.
   */
  private async showPictures(pictures: Record<string, PresetPicture>): Promise<void> {
    const generation = ++this.pictureGeneration;
    const current = (): boolean => generation === this.pictureGeneration;
    const missing: string[] = [];
    for (const [layer, def] of IMAGE_LAYERS.entries()) {
      const wanted = pictures[def.id];
      if (!wanted) {
        if (this.pictures[layer]) this.setPicture(layer, null, null);
        continue;
      }
      if (this.pictures[layer]?.id === wanted.id) continue;
      if (!(await this.loadKept(wanted, layer, current))) {
        missing.push(wanted.name);
        if (current()) this.setPicture(layer, null, null);
      }
      if (!current()) return;
    }
    if (missing.length > 0) {
      const more = missing.length > 1 ? ` and ${missing.length - 1} more` : '';
      toastError(new Error(`The picture "${missing[0]}"${more} is no longer kept. Load ${more ? 'them' : 'it'} again and save the preset.`));
    }
  }

  /** The pictures on screen, by image layer, as a preset stores them. None when no layer has one. */
  private pictureRefs(): Record<string, PresetPicture> | undefined {
    const refs: Record<string, PresetPicture> = {};
    this.pictures.forEach((picture, layer) => {
      if (picture?.id) refs[IMAGE_LAYERS[layer]!.id] = { id: picture.id, name: picture.name };
    });
    return Object.keys(refs).length > 0 ? refs : undefined;
  }

  /** Loads every picture again into a new renderer, after the graphics context was lost. */
  private async reloadPictures(): Promise<void> {
    for (const [layer, picture] of this.pictures.entries()) {
      if (!picture) continue;
      const same = (): boolean => this.pictures[layer] === picture;
      if (!(await this.loadKept(picture, layer, same)) && same()) this.setPicture(layer, null, null);
    }
  }

  /**
   * Tidies the kept pictures, keeping those that saved presets and the last session use, then
   * puts back the pictures that were on screen. Nothing is deleted when the saved presets or the
   * session could not be read, since they might still need them.
   */
  private async startPictures(state: PresetData | null, intact: boolean): Promise<void> {
    if (intact && this.presets.intact) {
      const keep = new Set([...this.presets.pictureIds, ...Object.values(state?.pictures ?? {}).map((p) => p.id)]);
      this.storeReady = this.store.keepOnly(keep).catch(() => undefined);
      await this.storeReady;
    }
    if (state?.pictures) await this.showPictures(state.pictures);
  }

  // --- presets -----------------------------------------------------------------------------------

  private randomize(): void {
    randomizeLook(this.params, this.rng);
    this.header.syncPresets('');
  }

  /** Applies a preset, with its pictures when it has them. */
  private applyPreset(id: string): void {
    const preset = this.presets.apply(id);
    if (preset?.data.pictures) void this.showPictures(preset.data.pictures);
  }

  private savePreset(name: string): void {
    const preset = this.presets.save(name, this.pictureRefs());
    this.header.syncPresets(preset.id);
    const count = Object.keys(preset.data.pictures ?? {}).length;
    toast(`Saved preset "${name}"${count > 0 ? ` with ${count} picture${count === 1 ? '' : 's'}` : ''}`);
  }

  private async importPreset(): Promise<void> {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    try {
      const data = this.presets.importJson(await file.text());
      toast(`Loaded "${data.name ?? file.name}"`);
      if (data.pictures) await this.showPictures(await this.keepPresetFiles(data));
    } catch (error) {
      toastError(error);
    }
  }

  /**
   * Keeps the pictures carried in a preset file. Returns the preset's pictures, under the ids
   * they are now kept by.
   */
  private async keepPresetFiles(data: PresetData): Promise<Record<string, PresetPicture>> {
    const kept = new Map<string, string>();
    for (const [id, base64] of Object.entries(data.pictureFiles ?? {})) {
      const bytes = fromBase64(base64);
      const keptId = await this.keep(new Blob([bytes]));
      if (keptId) kept.set(id, keptId);
    }
    const pictures: Record<string, PresetPicture> = {};
    for (const [layer, picture] of Object.entries(data.pictures ?? {})) {
      pictures[layer] = { ...picture, id: kept.get(picture.id) ?? picture.id };
    }
    return pictures;
  }

  /** The current look as a preset file, with its pictures inside, so it can be moved or kept. */
  async presetFile(name = `${BRAND.name} preset`): Promise<string> {
    const pictures = this.pictureRefs();
    const data: PresetData = { ...this.params.snapshot(), name, ...(pictures ? { pictures } : {}) };
    if (pictures) {
      data.pictureFiles = {};
      for (const { id } of Object.values(pictures)) {
        if (id === TEST_CARD || data.pictureFiles[id]) continue;
        const blob = await this.store.get(id);
        if (blob) data.pictureFiles[id] = await toBase64(blob);
      }
    }
    return JSON.stringify(data, null, 2);
  }

  private async exportPreset(): Promise<void> {
    const text = await this.presetFile();
    downloadBlob(new Blob([text], { type: 'application/json' }), `${BRAND.slug}-preset.json`);
  }

  private stepPreset(direction: number): void {
    const all = this.presets.all;
    if (all.length === 0) return;
    this.presetIndex = (this.presetIndex + direction + all.length) % all.length;
    const preset = all[this.presetIndex]!;
    this.applyPreset(preset.id);
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
        cycler: this.cycler,
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
      this.cycler.reset();
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
        case 'KeyC': {
          const on = !this.params.bool('cycle.on');
          this.params.set('cycle.on', on);
          toast(on ? 'Cycling through looks' : 'Cycle off');
          break;
        }
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
      const files = [...(event.dataTransfer?.files ?? [])];
      const pictures = files.filter((file) => file.type.startsWith('image/'));
      if (pictures.length > 0) {
        void this.addImages(pictures);
      } else if (files[0]) {
        this.audio
          .useFile(files[0])
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
      this.applyResolution();
      this.contextLost = false;
      void this.reloadPictures();
      toast('Graphics context restored');
    });
  }

  // --- persistence -------------------------------------------------------------------------------

  /** Remembers the look and the pictures on screen for the next session. */
  private saveState(): void {
    const state: PresetData = { ...this.params.snapshot({ includeSystem: true }), pictures: this.pictureRefs() ?? {} };
    storage.set(STATE_KEY, JSON.stringify(state));
  }

  /**
   * Restores the look of the last session. Its pictures follow once the app is running.
   * @returns the stored session, and whether it could be read
   */
  private restoreState(): { state: PresetData | null; intact: boolean } {
    const raw = storage.get(STATE_KEY);
    if (!raw) return { state: null, intact: true };
    try {
      const state = JSON.parse(raw) as PresetData;
      this.params.load(upgradePreset(state), { includeSystem: true });
      return { state, intact: true };
    } catch {
      // A corrupt entry is ignored and overwritten on the next change.
      return { state: null, intact: false };
    }
  }
}
