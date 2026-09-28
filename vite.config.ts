import { defineConfig } from 'vitest/config';
import { exportBridge } from './tools/exportBridge';

export default defineConfig({
  plugins: [exportBridge({ exportDir: 'exports' })],
  server: {
    port: 5173,
    strictPort: true,
    // Exported videos land in exports/. Watching them would reload the page mid-export.
    watch: { ignored: ['**/exports/**'] },
  },
  preview: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
