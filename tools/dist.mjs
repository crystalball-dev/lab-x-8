/**
 * Builds the portable desktop application into release/<product name>/.
 *
 *   npm run dist            the folder, with FFmpeg inside
 *   npm run dist -- --zip   the folder, plus a zip archive of it for handing on
 *   npm run dist -- --exe   the folder, plus a single-file build
 *
 * The single file is convenient to pass around but slow to start, because it unpacks itself
 * on every launch. The folder starts at once and is the one to use.
 *
 * The folder is updated in place. Settings, presets and exports that the app has stored next
 * to itself are kept, so rebuilding never loses work.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** "Lab X-8". Names the program, its folder and the folder it keeps its data in. */
const { productName } = JSON.parse(readFileSync('package.json', 'utf8'));
/** "Lab-X-8". The name in file names meant for handing on. */
const fileStem = productName.replace(/\s+/g, '-');

const RELEASE = 'release';
const BUILT = join(RELEASE, 'win-unpacked');
const TARGET = join(RELEASE, productName);
/** What the app writes next to itself. Never deleted by a rebuild. */
const KEEP = new Set([`${productName} Data`, 'Exports']);

/** Runs a command line through the shell, which is what finds npm and npx on Windows. */
function run(commandLine) {
  console.log(`\n> ${commandLine}`);
  const result = spawnSync(commandLine, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nFailed: ${commandLine}`);
    process.exit(result.status ?? 1);
  }
}

function folderSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(path) : statSync(path).size;
  }
  return total;
}

run('npm run build');
run('node tools/build-desktop.mjs');
run('node tools/prepare-ffmpeg.mjs');
const singleFile = process.argv.includes('--exe');
run(`npx electron-builder --win dir${singleFile ? ' portable' : ''} --x64 --config electron-builder.yml`);

// The fresh build moves to a staging folder that carries the final name, so the archive
// unpacks to a folder named after the product.
const STAGE = join(RELEASE, '.stage');
const staged = join(STAGE, productName);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
renameSync(BUILT, staged);
rmSync(join(RELEASE, 'builder-debug.yml'), { force: true });

if (process.argv.includes('--zip')) {
  const archive = join(RELEASE, `${fileStem}-portable.zip`);
  rmSync(archive, { force: true });
  // Made from the fresh build, before it meets this machine's settings and exports.
  run(
    `powershell -NoProfile -Command "Compress-Archive -LiteralPath '${staged}' ` +
      `-DestinationPath '${archive}' -CompressionLevel Optimal"`,
  );
  console.log(`Archive: ${archive}  (${(statSync(archive).size / 1e6).toFixed(0)} MB)`);
}

// Replace the program, keep the user's data.
mkdirSync(TARGET, { recursive: true });
try {
  for (const name of readdirSync(TARGET)) {
    if (!KEEP.has(name)) rmSync(join(TARGET, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(staged)) {
    if (!KEEP.has(name)) renameSync(join(staged, name), join(TARGET, name));
  }
} catch (error) {
  console.error(`\nCould not update ${TARGET}. Close the app if it is running, then try again.`);
  console.error(String(error));
  process.exit(1);
}
rmSync(STAGE, { recursive: true, force: true });

const megabytes = (folderSize(TARGET) / 1e6).toFixed(0);
console.log(`\nPortable app: ${TARGET}  (${megabytes} MB)`);
console.log(`Start it with ${join(TARGET, `${productName}.exe`)}`);

if (singleFile) {
  // Named in electron-builder.yml.
  const file = join(RELEASE, `${fileStem}-portable.exe`);
  console.log(`Single file: ${file}  (${(statSync(file).size / 1e6).toFixed(0)} MB)`);
}

if (!existsSync(join(TARGET, 'resources', 'ffmpeg'))) {
  console.warn('\nFFmpeg is not inside the app. Exports are limited to the built-in encoders');
  console.warn(`unless FFmpeg is on the PATH or placed next to ${productName}.exe.`);
}
