/**
 * Hosts the export bridge inside the Vite development and preview servers, so that the app
 * can reach FFmpeg and the disk while it runs in an ordinary browser.
 *
 * The desktop application hosts the same bridge itself. See electron/server.ts.
 */
import type { Server } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { ExportBridge } from '../bridge/ExportBridge';

export interface BridgePluginOptions {
  /** Folder that receives the exported files. */
  exportDir?: string;
  /** FFmpeg executable. Defaults to `ffmpeg` on the PATH. */
  ffmpegPath?: string;
}

export function exportBridge(options: BridgePluginOptions = {}): Plugin {
  const bridge = new ExportBridge({
    exportDir: options.exportDir ?? 'exports',
    ffmpegPaths: [options.ffmpegPath ?? 'ffmpeg'],
  });

  const install = (middlewares: Connect.Server, httpServer: Server | null): void => {
    middlewares.use((req, res, next) => {
      if (!bridge.handleRequest(req, res)) next();
    });
    if (!httpServer) return;
    // Upgrades the bridge does not claim, such as the hot reload socket, are left alone.
    httpServer.on('upgrade', (req, socket, head) => {
      bridge.handleUpgrade(req, socket, head);
    });
    httpServer.on('close', () => void bridge.dispose());
  };

  return {
    name: 'visualizer-export-bridge',
    configureServer(server) {
      install(server.middlewares, server.httpServer as Server | null);
    },
    configurePreviewServer(server) {
      install(server.middlewares, server.httpServer as Server | null);
    },
  };
}
