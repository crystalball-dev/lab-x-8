import { BridgeSocket, bridgeRequest, postJson, type BridgeFile } from './bridge';
import type { ExportResult, ExportSettings, FrameSink } from './types';

/** Encodes an AudioBuffer as a 16-bit PCM WAV file, with dither. */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const dataBytes = frames * channels * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);

  const samples = new Int16Array(out, 44, frames * channels);
  // A fixed seed keeps the dither, and with it the file, identical between exports.
  let seed = 0x2545f491;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let c = 0; c < channels; c++) {
    const source = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      // Triangular dither of one step hides the rounding to 16 bits.
      const dithered = source[i]! * 32767 + random() - random();
      samples[i * channels + c] = Math.max(-32768, Math.min(32767, Math.round(dithered)));
    }
  }
  return out;
}

/**
 * Sends raw frames to FFmpeg through the local export bridge.
 * Every frame is read back from the GPU, so it is slower than the browser encoder, but it
 * reaches ProRes, HAP and the high quality software encoders, and nothing is lost on the way.
 */
export class FfmpegSink implements FrameSink {
  private id: string | null = null;
  private socket: BridgeSocket | null = null;
  private readonly frame: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly settings: ExportSettings,
    /** The complete audio section. FFmpeg needs it before the first frame. */
    private readonly audio: AudioBuffer | null,
    /** A place the user picked in the desktop app's save dialog. */
    private readonly outputPath: string | null = null,
  ) {
    this.frame = new Uint8Array(settings.width * settings.height * 4);
  }

  async start(): Promise<void> {
    const { settings } = this;
    const session = await postJson<{ id: string }>('/sessions', {
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      codec: settings.codec,
      bitrate: settings.bitrate,
      name: settings.name,
      outputPath: this.outputPath ?? undefined,
    });
    this.id = session.id;
    if (settings.includeAudio && this.audio) {
      await bridgeRequest(`/sessions/${this.id}/audio`, {
        method: 'PUT',
        body: encodeWav(this.audio),
      });
    }
    await bridgeRequest(`/sessions/${this.id}/start`, { method: 'POST' });
    this.socket = await BridgeSocket.open(this.id);
  }

  async addFrame(): Promise<void> {
    const { gl, settings, frame } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, settings.width, settings.height, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    await this.socket!.send(frame);
  }

  async addAudio(): Promise<void> {
    // The whole audio section was uploaded in start().
  }

  async finish(): Promise<ExportResult> {
    await this.socket!.drain();
    this.socket!.close();
    const done = await bridgeRequest<BridgeFile>(`/sessions/${this.id}/finish`, { method: 'POST' });
    this.id = null;
    return { fileName: done.fileName, bytes: done.bytes, location: done.path, path: done.path };
  }

  async cancel(): Promise<void> {
    this.socket?.close();
    if (!this.id) return;
    const id = this.id;
    this.id = null;
    await bridgeRequest(`/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}
