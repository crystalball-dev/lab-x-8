/** Shared types of the export subsystem. */

export type EncoderKind = 'browser' | 'ffmpeg';

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  /** Start position in the track, seconds. */
  start: number;
  /** Length of the export, seconds. */
  duration: number;
  encoder: EncoderKind;
  /** Codec id. Browser: avc, hevc, vp9, av1. FFmpeg bridge: see FFMPEG_CODECS in the bridge. */
  codec: string;
  /** Target video bitrate in bits per second, for bitrate-based codecs. */
  bitrate: number;
  includeAudio: boolean;
  /** File name without extension. */
  name: string;
}

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  /** Wall-clock seconds since the export started. */
  elapsed: number;
  /** Frames rendered per wall-clock second. */
  speed: number;
}

export interface ExportResult {
  fileName: string;
  bytes: number;
  /** Where the file ended up, in words the UI can show. */
  location: string;
  /** Full path on disk, when the file was written through the export bridge. */
  path?: string;
  /** Present when the file was assembled in memory and still has to be saved. */
  blob?: Blob;
}

/** Receives rendered frames and audio and turns them into a file. */
export interface FrameSink {
  start(): Promise<void>;
  /**
   * Captures the current canvas contents as the frame at `timestamp`.
   * Resolves when the encoder is ready for more, which applies backpressure to the renderer.
   */
  addFrame(timestamp: number, duration: number): Promise<void>;
  /** Appends audio. Chunks are placed one after another. */
  addAudio(chunk: AudioBuffer): Promise<void>;
  finish(): Promise<ExportResult>;
  cancel(): Promise<void>;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelled';
  }
}
