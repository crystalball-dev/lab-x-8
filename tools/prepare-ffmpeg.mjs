/**
 * Copies the FFmpeg found on this machine into vendor/ffmpeg/, from where the packaging step
 * puts it inside the app. Run it once before `npm run dist`.
 *
 * Without it the packaged app still works. It then uses an FFmpeg placed next to it, or one
 * on the PATH, and offers only the built-in encoders when there is none.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { productName } = JSON.parse(readFileSync('package.json', 'utf8'));
const windows = process.platform === 'win32';
const name = windows ? 'ffmpeg.exe' : 'ffmpeg';
const target = join('vendor', 'ffmpeg');

function locate() {
  const explicit = process.env.LABX8_FFMPEG;
  if (explicit && existsSync(explicit)) return explicit;
  const found = spawnSync(windows ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  const first = (found.stdout ?? '').split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

const located = locate();
if (!located) {
  console.warn('FFmpeg was not found. The app will be packaged without it.');
  process.exit(0);
}

// Package managers install a small launcher on the PATH. Follow it to the real program.
const source = realpathSync(located);
const version = spawnSync(source, ['-hide_banner', '-version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.warn(`${source} does not run. The app will be packaged without FFmpeg.`);
  process.exit(0);
}
const banner = version.stdout.split(/\r?\n/)[0].trim();

mkdirSync(target, { recursive: true });
copyFileSync(source, join(target, name));

// The copy has to run on its own, without libraries that lived next to the original.
const check = spawnSync(join(target, name), ['-hide_banner', '-version'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('The copied FFmpeg does not run on its own. It probably needs shared libraries.');
  process.exit(1);
}

// FFmpeg comes with a licence that has to travel with it.
let licence = 'not found next to the program';
for (const folder of [dirname(source), dirname(dirname(source))]) {
  const file = join(folder, 'LICENSE');
  if (existsSync(file)) {
    copyFileSync(file, join(target, 'LICENSE.txt'));
    licence = file;
    break;
  }
}

writeFileSync(
  join(target, 'ABOUT.txt'),
  [
    `FFmpeg, bundled with ${productName} for video export.`,
    '',
    banner,
    `Copied from: ${source}`,
    `Licence:     ${licence}`,
    '',
    'FFmpeg is a separate program under its own licence (see LICENSE.txt).',
    `${productName} starts it as a separate process and does not link against it.`,
    'Source code: https://ffmpeg.org/download.html',
    '',
  ].join('\n'),
);

const megabytes = (statSync(join(target, name)).size / 1e6).toFixed(0);
console.log(`Bundled ${banner}`);
console.log(`  from ${source} (${megabytes} MB)`);
