import { BRAND } from '../brand';
import { BROWSER_CODECS, browserFileExtension, probeBrowserCodecs } from '../export/BrowserSink';
import { probeBridge, type BridgeInfo } from '../export/bridge';
import {
  ExportCancelled,
  type EncoderKind,
  type ExportProgress,
  type ExportResult,
  type ExportSettings,
} from '../export/types';
import { RESOLUTIONS, parseResolution } from '../params/schema';
import { desktop } from '../platform/desktop';
import { button, downloadBlob, formatBytes, formatTime, h } from '../util/dom';

export type Destination = 'file' | 'folder' | 'download';

export interface ExportRequest {
  settings: ExportSettings;
  destination: Destination;
  /** Browser: the file picked with the File System Access API. */
  fileHandle: FileSystemFileHandle | null;
  /** Desktop: the path picked in the system's save dialog. */
  outputPath: string | null;
}

export interface ExportHost {
  /** The track that would be rendered, or null when the source is a live input. */
  track(): { duration: number; label: string } | null;
  defaultResolution(): string;
  run(
    request: ExportRequest,
    onProgress: (progress: ExportProgress) => void,
    signal: AbortSignal,
  ): Promise<ExportResult>;
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
}

const FRAME_RATES = ['24', '25', '30', '50', '60'];

function field(label: string, control: HTMLElement, hint = ''): HTMLElement {
  return h('div', { class: 'row wide', title: hint }, [
    h('label', { class: 'row-label', text: label }),
    control,
  ]);
}

function options(select: HTMLSelectElement, items: Array<{ value: string; label: string }>): void {
  const previous = select.value;
  select.replaceChildren(
    ...items.map((o) => h('option', { text: o.label, attrs: { value: o.value } })),
  );
  if (items.some((o) => o.value === previous)) select.value = previous;
}

/** Suggested bitrate in megabits per second for good quality with busy, noisy content. */
function suggestedMbps(width: number, height: number, fps: number): number {
  const megapixels = (width * height) / 1e6;
  return Math.round(megapixels * (fps > 30 ? 20 : 13));
}

/** The export window: settings, progress and result. */
export class ExportDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly encoder = h('select');
  private readonly codec = h('select');
  private readonly resolution = h('select');
  private readonly fps = h('select');
  private readonly bitrate = h('input', { attrs: { type: 'number', min: '1', max: '400', step: '1' } });
  private readonly start = h('input', { attrs: { type: 'number', min: '0', step: '0.1' } });
  private readonly length = h('input', { attrs: { type: 'number', min: '0.1', step: '0.1' } });
  private readonly audio = h('input', { attrs: { type: 'checkbox' } });
  private readonly destination = h('select');
  private readonly name = h('input', { attrs: { type: 'text', maxlength: '80' } });
  private readonly bar = h('i');
  private readonly status = h('div', { class: 'status' });
  private readonly renderButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly revealButton: HTMLButtonElement;
  private readonly form: HTMLElement;

  private bridge: BridgeInfo | null = null;
  private abort: AbortController | null = null;
  private result: ExportResult | null = null;
  private duration = 0;

  constructor(private readonly host: ExportHost) {
    options(this.resolution, RESOLUTIONS);
    options(
      this.fps,
      FRAME_RATES.map((f) => ({ value: f, label: `${f} fps` })),
    );
    this.fps.value = '60';
    this.audio.checked = true;
    this.name.value = BRAND.slug;

    this.renderButton = button('Render', () => void this.render(), 'primary');
    this.closeButton = button('Close', () => this.close());
    this.downloadButton = button('Download', () => {
      if (this.result?.blob) downloadBlob(this.result.blob, this.result.fileName);
    });
    this.downloadButton.hidden = true;
    this.revealButton = button('Show in folder', () => {
      if (this.result?.path) desktop?.showInFolder(this.result.path);
    });
    this.revealButton.hidden = true;

    this.form = h('div', { class: 'modal-body' }, [
      field('Encoder', this.encoder),
      field('Codec', this.codec),
      field('Resolution', this.resolution),
      field('Frame rate', this.fps),
      field('Bitrate (Mbit/s)', this.bitrate, 'Used by H.264, HEVC, AV1 and VP9'),
      field('Start (s)', this.start),
      field('Length (s)', this.length),
      field('Include audio', this.audio),
      field('Save to', this.destination),
      field('File name', this.name),
    ]);

    this.dialog = h('dialog', { class: 'modal' }, [
      h('div', { class: 'modal-head', text: 'EXPORT VIDEO' }),
      this.form,
      h('div', { class: 'modal-body' }, [h('div', { class: 'progress' }, [this.bar]), this.status]),
      h('div', { class: 'modal-foot' }, [
        this.revealButton,
        this.downloadButton,
        this.closeButton,
        this.renderButton,
      ]),
    ]);
    // Escape must not close the window while a render is running.
    this.dialog.addEventListener('cancel', (event) => {
      if (this.abort) event.preventDefault();
    });

    this.encoder.addEventListener('change', () => void this.refreshCodecs());
    this.resolution.addEventListener('change', () => {
      this.suggestBitrate();
      void this.refreshCodecs();
    });
    this.fps.addEventListener('change', () => this.suggestBitrate());
    this.codec.addEventListener('change', () => this.refreshDestinations());
    document.body.append(this.dialog);
  }

  get open(): boolean {
    return this.dialog.open;
  }

  async show(): Promise<void> {
    const track = this.host.track();
    this.result = null;
    this.downloadButton.hidden = true;
    this.revealButton.hidden = true;
    this.bar.style.width = '0';
    this.setStatus('');

    if (!track) {
      this.form.hidden = true;
      this.renderButton.disabled = true;
      this.setStatus(
        'Offline export renders a track. Load an audio file or the demo loop first.\n' +
          'To capture a live input, use the Record button instead.',
        'error',
      );
      this.dialog.showModal();
      return;
    }

    this.form.hidden = false;
    this.renderButton.disabled = false;
    this.duration = track.duration;
    this.resolution.value = this.host.defaultResolution();
    this.start.value = '0';
    this.start.max = String(track.duration);
    this.length.value = track.duration.toFixed(2);
    this.length.max = String(track.duration);

    this.bridge = await probeBridge();
    const encoders = [
      { value: 'browser', label: `${desktop ? 'Built in' : 'Browser'} (WebCodecs, GPU accelerated)` },
    ];
    if (this.bridge) encoders.push({ value: 'ffmpeg', label: 'FFmpeg (ProRes, HAP, x264, NVENC)' });
    options(this.encoder, encoders);
    this.suggestBitrate();
    await this.refreshCodecs();
    this.setStatus(`${track.label}  ${formatTime(track.duration)}`);
    this.dialog.showModal();
  }

  close(): void {
    if (this.abort) {
      this.abort.abort();
      return;
    }
    this.dialog.close();
  }

  private suggestBitrate(): void {
    const { width, height } = parseResolution(this.resolution.value);
    this.bitrate.value = String(suggestedMbps(width, height, Number(this.fps.value)));
  }

  private async refreshCodecs(): Promise<void> {
    const { width, height } = parseResolution(this.resolution.value);
    if (this.encoder.value === 'ffmpeg' && this.bridge) {
      options(
        this.codec,
        this.bridge.codecs.map((c) => ({ value: c.id, label: c.label })),
      );
    } else {
      const supported = await probeBrowserCodecs(width, height, Number(this.bitrate.value) * 1e6);
      const items = BROWSER_CODECS.filter((c) => supported.includes(c.id)).map((c) => ({
        value: c.id,
        label: c.label,
      }));
      options(this.codec, items);
      if (items.length === 0) {
        this.setStatus(
          desktop
            ? 'No built-in encoder can handle this size. Use the FFmpeg encoder.'
            : 'This browser cannot encode video at this size. Use Chrome or Edge, or the FFmpeg encoder.',
          'error',
        );
      }
    }
    this.renderButton.disabled = this.codec.options.length === 0;
    this.refreshDestinations();
  }

  private refreshDestinations(): void {
    const items: Array<{ value: Destination; label: string }> = [];
    if (desktop) {
      // The desktop app writes straight to disk, whichever encoder is used.
      items.push({ value: 'folder', label: `Exports folder (${desktop.exportDir})` });
      items.push({ value: 'file', label: 'Choose a file' });
    } else if (this.encoder.value === 'ffmpeg') {
      items.push({ value: 'folder', label: `Project folder (${this.bridge?.exportDir ?? 'exports'})` });
    } else {
      if ((window as SavePickerWindow).showSaveFilePicker) {
        items.push({ value: 'file', label: 'Choose a file (streams to disk)' });
      }
      if (this.bridge) {
        items.push({ value: 'folder', label: `Project folder (${this.bridge.exportDir})` });
      }
      items.push({ value: 'download', label: 'Download when finished' });
    }
    options(this.destination, items);

    const usesBitrate =
      this.encoder.value === 'ffmpeg'
        ? (this.bridge?.codecs.find((c) => c.id === this.codec.value)?.usesBitrate ?? true)
        : true;
    this.bitrate.disabled = !usesBitrate;
  }

  /** File extension the chosen encoder and codec will produce. */
  private extension(settings: ExportSettings): string {
    if (settings.encoder === 'ffmpeg') {
      return this.bridge?.codecs.find((c) => c.id === settings.codec)?.extension ?? 'mp4';
    }
    return browserFileExtension(settings.codec);
  }

  private readSettings(): ExportSettings {
    const { width, height } = parseResolution(this.resolution.value);
    const start = Math.min(Math.max(0, Number(this.start.value) || 0), this.duration - 0.1);
    const length = Math.min(Math.max(0.1, Number(this.length.value) || this.duration), this.duration - start);
    const name = this.name.value.trim().replace(/[^\w.\- ]+/g, '_') || BRAND.slug;
    return {
      width,
      height,
      fps: Number(this.fps.value),
      start,
      duration: length,
      encoder: this.encoder.value as EncoderKind,
      codec: this.codec.value,
      bitrate: Math.max(1, Number(this.bitrate.value) || 40) * 1e6,
      includeAudio: this.audio.checked,
      name,
    };
  }

  private async render(): Promise<void> {
    if (this.abort) return;
    const settings = this.readSettings();
    const destination = this.destination.value as Destination;

    let fileHandle: FileSystemFileHandle | null = null;
    let outputPath: string | null = null;
    if (destination === 'file' && desktop) {
      outputPath = await desktop.chooseExportFile(`${settings.name}.${this.extension(settings)}`);
      if (!outputPath) return; // The save dialog was dismissed.
    } else if (destination === 'file') {
      const extension = browserFileExtension(settings.codec);
      try {
        // Must run inside the click, before any other asynchronous work.
        fileHandle = await (window as SavePickerWindow).showSaveFilePicker!({
          suggestedName: `${settings.name}.${extension}`,
          types: [
            {
              description: extension === 'webm' ? 'WebM video' : 'MP4 video',
              accept: { [extension === 'webm' ? 'video/webm' : 'video/mp4']: [`.${extension}`] },
            },
          ],
        });
      } catch {
        return; // The save dialog was dismissed.
      }
    }

    this.abort = new AbortController();
    this.result = null;
    this.downloadButton.hidden = true;
    this.revealButton.hidden = true;
    this.form.inert = true;
    this.renderButton.disabled = true;
    this.closeButton.textContent = 'Cancel';
    this.setStatus('Starting encoder');

    try {
      const result = await this.host.run(
        { settings, destination, fileHandle, outputPath },
        (progress) => this.showProgress(progress, settings.fps),
        this.abort.signal,
      );
      this.result = result;
      this.bar.style.width = '100%';
      this.downloadButton.hidden = !result.blob;
      this.revealButton.hidden = !(desktop && result.path);
      this.setStatus(
        `Done. ${result.fileName}  ${formatBytes(result.bytes)}\n${result.location}`,
        'done',
      );
    } catch (error) {
      if (error instanceof ExportCancelled) this.setStatus('Cancelled. No file was written.');
      else {
        console.error(error);
        this.setStatus(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      this.abort = null;
      this.form.inert = false;
      this.renderButton.disabled = false;
      this.closeButton.textContent = 'Close';
    }
  }

  private showProgress(progress: ExportProgress, fps: number): void {
    const done = progress.frame / progress.totalFrames;
    this.bar.style.width = `${(done * 100).toFixed(1)}%`;
    const remaining = (progress.totalFrames - progress.frame) / Math.max(progress.speed, 0.01);
    this.setStatus(
      `Frame ${progress.frame} of ${progress.totalFrames}\n` +
        `${progress.speed.toFixed(1)} frames/s  (${(progress.speed / fps).toFixed(2)}x real time)\n` +
        `About ${formatTime(remaining)} remaining`,
    );
  }

  private setStatus(text: string, kind: '' | 'error' | 'done' = ''): void {
    this.status.textContent = text;
    this.status.className = `status ${kind}`.trim();
  }
}
