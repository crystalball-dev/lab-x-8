import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ExportBridge } from '../bridge/ExportBridge';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export interface AppServerOptions {
  bridge: ExportBridge;
  /** Folder with the built web app. */
  webRoot: string;
  /**
   * During development: the Vite server to pass everything except the bridge on to.
   * The page then hot-reloads inside the desktop shell.
   */
  devServer?: URL;
}

export interface AppServer {
  /** Where the window loads the app from, for example `http://127.0.0.1:50123`. */
  origin: string;
  close(): Promise<void>;
}

/** What the page may load and connect to. Everything comes from the app itself. */
function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' ws://127.0.0.1:${port}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The app's private web server. It listens on the loopback interface only, on a port the
 * system picks, and serves two things: the app's own files and the export bridge.
 */
export async function startServer(options: AppServerOptions): Promise<AppServer> {
  const { bridge, devServer } = options;
  const root = resolve(options.webRoot);
  let csp = '';

  const serveFile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://app').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(root, pathname));
    // Nothing outside the app folder is ever served.
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': csp,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  };

  const proxyRequest = (req: IncomingMessage, res: ServerResponse, target: URL): void => {
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('The development server is not running.');
    });
    req.pipe(upstream);
  };

  /** Passes a socket upgrade through untouched. Used for the hot reload connection. */
  const proxyUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, target: URL): void => {
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  };

  const server: Server = createServer((req, res) => {
    if (bridge.handleRequest(req, res)) return;
    if (devServer) proxyRequest(req, res, devServer);
    else void serveFile(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (bridge.handleUpgrade(req, socket, head)) return;
    if (devServer) proxyUpgrade(req, socket, head, devServer);
    else socket.destroy();
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const port = (server.address() as AddressInfo).port;
  csp = contentSecurityPolicy(port);

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
