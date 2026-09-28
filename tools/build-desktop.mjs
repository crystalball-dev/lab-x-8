/**
 * Compiles the desktop shell (electron/) into dist-electron/.
 * Everything the shell needs is bundled into two files, so the packaged app carries no
 * node_modules folder.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // Provided by Electron at run time, or optional accelerators that are not installed.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
};

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
