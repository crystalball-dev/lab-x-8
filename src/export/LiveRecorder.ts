/**
 * Records the live output in real time with MediaRecorder.
 *
 * Use it to capture a performance driven by a live input, where an offline render is not
 * possible. For tracks, the offline export gives better quality and never drops frames.
 */

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640033,mp4a.40.2',
  'video/mp4;codecs=avc1.64002A,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export interface RecordingResult {
  blob: Blob;
  fileName: string;
  seconds: number;
}

export class LiveRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private audioTap: MediaStreamAudioDestinationNode | null = null;
  private audioSource: AudioNode | null = null;

  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined';
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  get seconds(): number {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /**
   * @param canvas        the output canvas
   * @param fps           capture frame rate
   * @param bitrate       video bitrate in bits per second
   * @param audioNode     node carrying the audio to record, if any
   */
  start(canvas: HTMLCanvasElement, fps: number, bitrate: number, audioNode: AudioNode | null): void {
    if (this.recorder) return;
    const stream = canvas.captureStream(fps);
    if (audioNode) {
      const tap = (audioNode.context as AudioContext).createMediaStreamDestination();
      audioNode.connect(tap);
      this.audioTap = tap;
      this.audioSource = audioNode;
      for (const track of tap.stream.getAudioTracks()) stream.addTrack(track);
    }

    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 256_000,
    });
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
  }

  stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error('Not recording.'));
    const seconds = this.seconds;
    return new Promise((resolve) => {
      recorder.onstop = () => {
        for (const track of recorder.stream.getTracks()) track.stop();
        if (this.audioTap && this.audioSource) this.audioSource.disconnect(this.audioTap);
        this.audioTap = null;
        this.audioSource = null;
        this.recorder = null;
        const type = recorder.mimeType || 'video/webm';
        const extension = type.includes('mp4') ? 'mp4' : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        resolve({
          blob: new Blob(this.chunks, { type }),
          fileName: `visualizer-live-${stamp}.${extension}`,
          seconds,
        });
        this.chunks = [];
      };
      recorder.stop();
    });
  }
}
