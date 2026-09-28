/** Codecs offered through FFmpeg, and how each one is driven. */

export interface CodecSpec {
  label: string;
  /** FFmpeg encoder that must be present. */
  encoder: string;
  extension: string;
  /** True when the codec is controlled by the bitrate setting. */
  usesBitrate: boolean;
  video: (bitrate: number) => string[];
  audio: string[];
  /** Converts full-range RGB to tagged BT.709 video. False for codecs that store RGB. */
  yuv: boolean;
}

const AAC = ['-c:a', 'aac', '-b:a', '320k'];
const PCM = ['-c:a', 'pcm_s16le'];

export const FFMPEG_CODECS: Record<string, CodecSpec> = {
  h264_nvenc: {
    label: 'H.264 (NVIDIA NVENC)',
    encoder: 'h264_nvenc',
    extension: 'mp4',
    usesBitrate: true,
    video: (b) => [
      '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr',
      '-b:v', String(b), '-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(b * 2),
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ],
    audio: AAC,
    yuv: true,
  },
  libx264: {
    label: 'H.264 (x264, highest quality)',
    encoder: 'libx264',
    extension: 'mp4',
    usesBitrate: false,
    video: () => [
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ],
    audio: AAC,
    yuv: true,
  },
  hevc_nvenc: {
    label: 'H.265 / HEVC (NVIDIA NVENC)',
    encoder: 'hevc_nvenc',
    extension: 'mp4',
    usesBitrate: true,
    video: (b) => [
      '-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr',
      '-b:v', String(b), '-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(b * 2),
      '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart',
    ],
    audio: AAC,
    yuv: true,
  },
  prores_hq: {
    label: 'ProRes 422 HQ (MOV)',
    encoder: 'prores_ks',
    extension: 'mov',
    usesBitrate: false,
    video: () => ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'],
    audio: PCM,
    yuv: true,
  },
  prores_4444: {
    label: 'ProRes 4444 (MOV)',
    encoder: 'prores_ks',
    extension: 'mov',
    usesBitrate: false,
    video: () => ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', '-pix_fmt', 'yuv444p10le'],
    audio: PCM,
    yuv: true,
  },
  hap: {
    label: 'HAP (MOV, for VJ software)',
    encoder: 'hap',
    extension: 'mov',
    usesBitrate: false,
    video: () => ['-c:v', 'hap', '-format', 'hap', '-chunks', '4'],
    audio: PCM,
    yuv: false,
  },
  hap_q: {
    label: 'HAP Q (MOV, for VJ software)',
    encoder: 'hap',
    extension: 'mov',
    usesBitrate: false,
    video: () => ['-c:v', 'hap', '-format', 'hap_q', '-chunks', '4'],
    audio: PCM,
    yuv: false,
  },
};

/** File types the bridge is willing to write. */
export const ALLOWED_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv']);
