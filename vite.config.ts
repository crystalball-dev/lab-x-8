import { defineConfig } from 'vitest/config';
import { exportBridge } from './tools/exportBridge';

export default defineConfig({
  plugins: [exportBridge({ exportDir: 'exports' })],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        // Exported videos land here. Watching them would reload the page mid-export.
        '**/exports/**',
        // Build output and the desktop app's profile. On Windows a folder cannot be renamed
        // while folders inside it are watched, so packaging would fail while the dev server runs.
        '**/dist/**',
        '**/release/**',
        '**/dist-electron/**',
        '**/vendor/**',
        '**/.desktop-data/**',
      ],
    },
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
