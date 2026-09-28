import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { ExportBridge } from '../bridge/ExportBridge';
import { startServer, type AppServer } from '../electron/server';
import { SettingsFile } from '../electron/settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'visualizer-desktop-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SettingsFile', () => {
  it('starts empty when there is no file', () => {
    const settings = new SettingsFile(join(dir, 'settings.json'));
    expect(settings.values).toEqual({});
    expect(settings.window).toBeUndefined();
  });

  it('keeps values and the window across restarts', () => {
    const path = join(dir, 'data', 'settings.json');
    const first = new SettingsFile(path);
    first.setValue('look', '{"a":1}');
    first.setValue('gone', 'soon');
    first.setValue('gone', null);
    first.window = { x: 10, y: 20, width: 1280, height: 720, maximized: true };
    first.flush();

    const second = new SettingsFile(path);
    expect(second.values).toEqual({ look: '{"a":1}' });
    expect(second.window).toEqual({ x: 10, y: 20, width: 1280, height: 720, maximized: true });
  });

  it('writes by itself shortly after a change', async () => {
    const path = join(dir, 'settings.json');
    const settings = new SettingsFile(path);
    settings.setValue('key', 'value');
    expect(existsSync(path)).toBe(false);
    await new Promise((done) => setTimeout(done, 500));
    expect(JSON.parse(readFileSync(path, 'utf8')).values).toEqual({ key: 'value' });
  });

  it('hands out copies, so callers cannot change stored values by accident', () => {
    const settings = new SettingsFile(join(dir, 'settings.json'));
    settings.setValue('key', 'value');
    settings.values.key = 'changed';
    expect(settings.values.key).toBe('value');
  });

  it('sets a damaged file aside and starts fresh', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ this is not json');
    const settings = new SettingsFile(path);
    expect(settings.values).toEqual({});
    expect(readFileSync(`${path}.unreadable`, 'utf8')).toBe('{ this is not json');
  });

  it('ignores entries that are not text', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ version: 1, values: { good: 'yes', bad: 5, worse: null } }));
    expect(new SettingsFile(path).values).toEqual({ good: 'yes' });
  });
});

describe('App server', () => {
  let server: AppServer;
  let bridge: ExportBridge;
  let root: string;

  beforeEach(async () => {
    root = join(dir, 'web');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(root, 'assets', 'app.js'), 'export const ok = true;');
    writeFileSync(join(dir, 'secret.txt'), 'outside the app');
    bridge = new ExportBridge({ exportDir: join(dir, 'exports'), ffmpegPaths: ['none'], token: 't' });
    server = await startServer({ bridge, webRoot: root });
  });
  afterEach(async () => {
    await bridge.dispose();
    await server.close();
  });

  it('listens on the loopback interface only', () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves the app with a content security policy', async () => {
    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>app</title>');
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe-eval');
    // The data socket of the bridge is the only other thing the page may connect to.
    expect(policy).toContain(`ws://127.0.0.1:${new URL(server.origin).port}`);
  });

  it('serves scripts as scripts', async () => {
    const response = await fetch(`${server.origin}/assets/app.js`);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers 404 for files that do not exist', async () => {
    expect((await fetch(`${server.origin}/missing.js`)).status).toBe(404);
  });

  it('never serves anything outside the app folder', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/..%5csecret.txt']) {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain('outside the app');
    }
  });

  it('only reads, never writes', async () => {
    const response = await fetch(`${server.origin}/index.html`, { method: 'POST', body: 'x' });
    expect(response.status).toBe(405);
  });

  it('passes bridge requests to the bridge', async () => {
    const refused = await fetch(`${server.origin}/api/bridge/info`);
    expect(refused.status).toBe(403);
    const accepted = await fetch(`${server.origin}/api/bridge/info`, {
      headers: { 'x-bridge-token': 't' },
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { exportDir: string }).exportDir).toBe(join(dir, 'exports'));
  });

  it('refuses sockets that are not for the bridge', async () => {
    const socket = new WebSocket(`${server.origin.replace('http', 'ws')}/anything`);
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('open'));
      socket.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  });
});

describe('App server in development', () => {
  let upstream: Server;
  let upstreamSockets: WebSocketServer;
  let server: AppServer;
  let bridge: ExportBridge;

  beforeEach(async () => {
    // Stands in for the Vite development server.
    upstream = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end(`dev server saw ${req.method} ${req.url}`);
    });
    upstreamSockets = new WebSocketServer({ server: upstream });
    upstreamSockets.on('connection', (socket, req) => {
      socket.send(`hot reload channel ${req.url}`);
      socket.on('message', (data) => socket.send(`echo ${data.toString()}`));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const port = (upstream.address() as AddressInfo).port;

    bridge = new ExportBridge({ exportDir: join(dir, 'exports'), ffmpegPaths: ['none'] });
    server = await startServer({
      bridge,
      webRoot: join(dir, 'unused'),
      devServer: new URL(`http://127.0.0.1:${port}`),
    });
  });
  afterEach(async () => {
    await bridge.dispose();
    await server.close();
    upstreamSockets.close();
    await new Promise<void>((done) => {
      upstream.closeAllConnections();
      upstream.close(() => done());
    });
  });

  it('passes page requests on to the development server', async () => {
    const response = await fetch(`${server.origin}/src/main.ts?t=1`);
    expect(await response.text()).toBe('dev server saw GET /src/main.ts?t=1');
  });

  it('still answers bridge requests itself', async () => {
    const response = await fetch(`${server.origin}/api/bridge/info`);
    expect(((await response.json()) as { exportDir: string }).exportDir).toBe(join(dir, 'exports'));
  });

  it('passes the hot reload socket through in both directions', async () => {
    const socket = new WebSocket(`${server.origin.replace('http', 'ws')}/?token=abc`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => {
        received.push(data.toString());
        if (received.length === 1) socket.send('ping');
        else resolve();
      });
      socket.once('error', reject);
    });
    socket.close();
    expect(received).toEqual(['hot reload channel /?token=abc', 'echo ping']);
  });
});
