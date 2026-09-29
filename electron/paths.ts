import { app } from 'electron';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand';

export interface AppPaths {
  /** True when the app keeps its data next to the executable and can be carried around. */
  portable: boolean;
  /** Settings, presets and the browser engine's profile. */
  dataDir: string;
  /** Default destination of exported video. */
  exportDir: string;
  /** The built web app. */
  webRoot: string;
  /** FFmpeg executables to try, in order. */
  ffmpegCandidates: string[];
}

const FFMPEG = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/** Creates the folder and reports whether files can be written into it. */
function usable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides where the app reads and writes.
 *
 * A packaged app prefers the folder it was started from. That makes it portable: copy the
 * folder to another machine or a USB stick and settings, presets and exports travel with it.
 * When that folder is read-only, for example under Program Files, it falls back to the
 * user's profile.
 */
export function resolvePaths(): AppPaths {
  const override = process.env.LABX8_FFMPEG;
  const candidates = override ? [override] : [];

  if (!app.isPackaged) {
    const project = app.getAppPath();
    return {
      portable: false,
      dataDir: join(project, '.desktop-data'),
      exportDir: join(project, 'exports'),
      webRoot: join(project, 'dist'),
      ffmpegCandidates: [...candidates, join(project, 'vendor', 'ffmpeg', FFMPEG), 'ffmpeg'],
    };
  }

  // A single-file portable build unpacks to a temporary folder and names its real home here.
  const home = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'));
  const beside = join(home, `${BRAND.name} Data`);
  const portable = usable(beside);

  return {
    portable,
    dataDir: portable ? beside : app.getPath('userData'),
    exportDir: portable ? join(home, 'Exports') : join(app.getPath('videos'), BRAND.name),
    webRoot: join(app.getAppPath(), 'dist'),
    ffmpegCandidates: [
      ...candidates,
      // An FFmpeg placed next to the app wins over the bundled one, so it can be replaced.
      join(home, FFMPEG),
      join(home, 'ffmpeg', FFMPEG),
      join(process.resourcesPath, 'ffmpeg', FFMPEG),
      'ffmpeg',
    ],
  };
}
