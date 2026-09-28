import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  getEncodableVideoCodecs,
  getFirstEncodableAudioCodec,
  type AudioCodec,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny';
import {
  BridgeSocket,
  POSITION_HEADER_BYTES,
  bridgeRequest,
  postJson,
  type BridgeFile,
} from './bridge';
import type { ExportResult, ExportSettings, FrameSink } from './types';

export const BROWSER_CODECS: Array<{ id: VideoCodec; label: string; container: 'mp4' | 'webm' }> = [
  { id: 'avc', label: 'H.264 (MP4)', container: 'mp4' },
  { id: 'hevc', label: 'H.265 / HEVC (MP4)', container: 'mp4' },
  { id: 'av1', label: 'AV1 (MP4)', container: 'mp4' },
  { id: 'vp9', label: 'VP9 (WebM)', container: 'webm' },
];

/** Audio bitrates to try, best first. */
const AUDIO_BITRATES = [192_000, 160_000, 128_000];
/** Audio codecs worth offering. Uncompressed audio is left to the FFmpeg encoder. */
const COMPRESSED_AUDIO: AudioCodec[] = ['aac', 'opus'];

/** Where the encoded file goes. */
export type BrowserDestination =
  /** A file the user picked. Streams to disk. */
  | { kind: 'file'; handle: FileSystemFileHandle }
  /**
   * Through the export bridge. Streams to disk, into the exports folder or to `outputPath`
   * when the user picked a place in the desktop app's save dialog.
   */
  | { kind: 'bridge'; outputPath?: string | null }
  /** Assembled in memory and offered as a download. For short clips. */
  | { kind: 'memory' };

/** Returns the codecs this browser can encode at the requested size. */
export async function probeBrowserCodecs(
  width: number,
  height: number,
  bitrate: number,
): Promise<VideoCodec[]> {
  if (typeof VideoEncoder === 'undefined') return [];
  return getEncodableVideoCodecs(
    BROWSER_CODECS.map((c) => c.id),
    { width, height, quality: new Quality({ bitrate }) },
  );
}

export function browserFileExtension(codec: string): string {
  return BROWSER_CODECS.find((c) => c.id === codec)?.container === 'webm' ? 'webm' : 'mp4';
}

/**
 * Encodes with the browser's own (usually hardware accelerated) encoders through WebCodecs and
 * writes MP4 or WebM. Frames are taken straight from the canvas without a CPU readback.
 */
export class BrowserSink implements FrameSink {
  private output: Output | null = null;
  private video: CanvasSource | null = null;
  private audio: AudioBufferSource | null = null;
  private buffer: BufferTarget | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private bridgeId: string | null = null;
  private socket: BridgeSocket | null = null;
  private readonly fileName: string;

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly settings: ExportSettings,
    private readonly audioFormat: { sampleRate: number; channels: number } | null,
    private readonly destination: BrowserDestination,
  ) {
    this.fileName = `${settings.name}.${browserFileExtension(settings.codec)}`;
  }

  async start(): Promise<void> {
    const { settings } = this;
    const webm = browserFileExtension(settings.codec) === 'webm';
    const format = webm ? new WebMOutputFormat() : new Mp4OutputFormat();

    const output = new Output({ format, target: await this.openTarget() });
    this.video = new CanvasSource(this.canvas, {
      codec: settings.codec as VideoCodec,
      quality: new Quality({ bitrate: settings.bitrate }),
      keyFrameInterval: 1,
      latencyMode: 'quality',
    });
    output.addVideoTrack(this.video, { frameRate: settings.fps });

    if (settings.includeAudio && this.audioFormat) {
      // Probe with the exact configuration that will be used. Platform encoders accept only
      // certain bitrates, so a codec can be available and still reject a given setting.
      const candidates = format
        .getSupportedAudioCodecs()
        .filter((c) => COMPRESSED_AUDIO.includes(c));
      let chosen: { codec: AudioCodec; quality: Quality } | null = null;
      for (const bitrate of AUDIO_BITRATES) {
        const quality = new Quality({ bitrate });
        const codec = await getFirstEncodableAudioCodec(candidates, {
          numberOfChannels: this.audioFormat.channels,
          sampleRate: this.audioFormat.sampleRate,
          quality,
        });
        if (codec) {
          chosen = { codec, quality };
          break;
        }
      }
      if (!chosen) throw new Error('This browser cannot encode audio for the chosen container.');
      this.audio = new AudioBufferSource(chosen);
      output.addAudioTrack(this.audio);
    }

    await output.start();
    this.output = output;
  }

  async addFrame(timestamp: number, duration: number): Promise<void> {
    await this.video!.add(timestamp, duration);
  }

  async addAudio(chunk: AudioBuffer): Promise<void> {
    if (this.audio) await this.audio.add(chunk);
  }

  async finish(): Promise<ExportResult> {
    const output = this.output;
    if (!output) throw new Error('The export was never started.');
    await output.finalize();

    if (this.writable) {
      await this.writable.close();
      this.writable = null;
      const handle = (this.destination as { handle: FileSystemFileHandle }).handle;
      const file = await handle.getFile();
      return { fileName: file.name, bytes: file.size, location: 'Saved to the chosen file' };
    }
    if (this.socket) {
      await this.socket.drain();
      this.socket.close();
      const done = await bridgeRequest<BridgeFile>(`/sessions/${this.bridgeId}/finish`, {
        method: 'POST',
      });
      this.bridgeId = null;
      return { fileName: done.fileName, bytes: done.bytes, location: done.path, path: done.path };
    }
    const data = this.buffer!.buffer;
    if (!data) throw new Error('The encoder produced no data.');
    return {
      fileName: this.fileName,
      bytes: data.byteLength,
      location: 'Ready to download',
      blob: new Blob([data], { type: await output.getMimeType() }),
    };
  }

  async cancel(): Promise<void> {
    try {
      await this.output?.cancel();
    } finally {
      // Discard the partial file instead of leaving a broken one behind.
      if (this.writable) await this.writable.abort().catch(() => undefined);
      this.socket?.close();
      if (this.bridgeId) {
        await bridgeRequest(`/sessions/${this.bridgeId}`, { method: 'DELETE' }).catch(
          () => undefined,
        );
      }
    }
  }

  private async openTarget(): Promise<BufferTarget | StreamTarget> {
    const destination = this.destination;
    if (destination.kind === 'file') {
      this.writable = await destination.handle.createWritable();
      return new StreamTarget(this.writable as WritableStream<StreamTargetChunk>, {
        chunked: true,
      });
    }
    if (destination.kind === 'bridge') {
      const session = await postJson<{ id: string }>('/files', {
        name: this.fileName,
        outputPath: destination.outputPath ?? undefined,
      });
      this.bridgeId = session.id;
      const socket = await BridgeSocket.open(session.id);
      this.socket = socket;
      // Containers patch their headers at the end, so every chunk carries its file position.
      const stream = new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          const message = new Uint8Array(POSITION_HEADER_BYTES + chunk.data.byteLength);
          new DataView(message.buffer).setBigUint64(0, BigInt(chunk.position), true);
          message.set(chunk.data, POSITION_HEADER_BYTES);
          await socket.send(message);
        },
      });
      return new StreamTarget(stream, { chunked: true });
    }
    this.buffer = new BufferTarget();
    return this.buffer;
  }
}
