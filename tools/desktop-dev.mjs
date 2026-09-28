/**
 * Runs the desktop app against the Vite development server.
 * Shaders and code hot-reload inside the desktop window, exactly as they do in a browser.
 */
import electron from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

await import('./build-desktop.mjs');

const vite = await createServer();
await vite.listen();
const url = vite.resolvedUrls?.local[0];
if (!url) throw new Error('The development server did not report its address.');
console.log(`Development server: ${url}`);

const child = spawn(String(electron), ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VISUALIZER_DEV_SERVER: url },
});
child.on('exit', async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
