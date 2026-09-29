import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ExportBridge, POSITION_HEADER_BYTES, type ExportBridgeOptions } from '../bridge/ExportBridge';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

interface Host {
  bridge: ExportBridge;
  server: Server;
  base: string;
  dir: string;
  written: string[];
  close(): Promise<void>;
}

async function startHost(options: Partial<ExportBridgeOptions> = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'lab-x-8-bridge-'));
  const written: string[] = [];
  const bridge = new ExportBridge({
    exportDir: join(dir, 'exports'),
    onFileWritten: (path) => written.push(path),
    ...options,
  });
  const server = createServer((req, res) => {
    if (!bridge.handleRequest(req, res)) {
      res.statusCode = 404;
      res.end('not the bridge');
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return {
    bridge,
    server,
    base: `http://127.0.0.1:${port}`,
    dir,
    written,
    async close() {
      await bridge.dispose();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  host: Host,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Reply> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('x-bridge-token', init.token);
  const response = await fetch(`${host.base}/api/bridge${path}`, { ...init, headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function postJson(host: Host, path: string, body: unknown, token?: string): Promise<Reply> {
  return call(host, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    token,
  });
}

/** Minimal client for the data socket, with the same protocol as the renderer. */
class Socket {
  confirmed = 0;
  failure: string | null = null;
  private wake: (() => void) | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const [kind, ...rest] = data.toString().split(' ');
      if (kind === 'error') this.failure = rest.join(' ');
      else this.confirmed = Number(rest[0]);
      this.wake?.();
    });
    ws.on('close', () => this.wake?.());
  }

  static open(host: Host, id: string, query = ''): Promise<Socket> {
    const url = `${host.base.replace('http', 'ws')}/api/bridge/sessions/${id}/socket${query}`;
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new Socket(ws)));
      ws.once('error', reject);
    });
  }

  send(data: Buffer): void {
    this.ws.send(data, { binary: true });
  }

  async drain(sent: number): Promise<void> {
    this.ws.send('end');
    while (this.confirmed < sent && !this.failure) {
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  close(): void {
    this.ws.close();
  }
}

function positioned(position: number, payload: Buffer): Buffer {
  const message = Buffer.alloc(POSITION_HEADER_BYTES + payload.length);
  message.writeBigUInt64LE(BigInt(position), 0);
  payload.copy(message, POSITION_HEADER_BYTES);
  return message;
}

describe('ExportBridge', () => {
  let host: Host;
  beforeEach(async () => {
    host = await startHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it('leaves requests for other paths to the host', async () => {
    const response = await fetch(`${host.base}/index.html`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not the bridge');
  });

  it('reports its export folder', async () => {
    const info = await call(host, '/info');
    expect(info.status).toBe(200);
    expect(info.body.exportDir).toBe(join(host.dir, 'exports'));
    expect(Array.isArray(info.body.codecs)).toBe(true);
  });

  it('refuses requests that come from another origin', async () => {
    const foreign = await call(host, '/info', { headers: { Origin: 'https://example.com' } });
    expect(foreign.status).toBe(403);
    const crossSite = await call(host, '/info', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
  });

  it('stores a file written out of order', async () => {
    const created = await postJson(host, '/files', { name: 'clip.mp4' });
    expect(created.status).toBe(200);
    const socket = await Socket.open(host, String(created.body.id));

    // Containers write the body first and patch the header afterwards.
    const tail = Buffer.from('WORLD');
    const head = Buffer.from('HELLO ');
    const first = positioned(6, tail);
    const second = positioned(0, head);
    socket.send(first);
    socket.send(second);
    await socket.drain(first.length + second.length);
    socket.close();

    const done = await postJson(host, `/sessions/${String(created.body.id)}/finish`, {});
    expect(done.status).toBe(200);
    expect(done.body.bytes).toBe(11);
    expect(readFileSync(String(done.body.path), 'utf8')).toBe('HELLO WORLD');
    expect(host.written).toEqual([done.body.path]);
  });

  it('never overwrites an existing export', async () => {
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await postJson(host, '/files', { name: 'same.mp4' });
      await postJson(host, `/sessions/${String(created.body.id)}/finish`, {});
      names.push(String(created.body.fileName));
    }
    expect(names).toEqual(['same.mp4', 'same (1).mp4', 'same (2).mp4']);
  });

  it('only writes video files, and only under safe names', async () => {
    expect((await postJson(host, '/files', { name: 'script.exe' })).status).toBe(400);
    expect((await postJson(host, '/files', { name: 'noextension' })).status).toBe(400);
    const sneaky = await postJson(host, '/files', { name: '../../outside.mp4' });
    expect(sneaky.status).toBe(200);
    await postJson(host, `/sessions/${String(sneaky.body.id)}/finish`, {});
    expect(readdirSync(join(host.dir, 'exports')).filter((f) => f.endsWith('.mp4'))).toHaveLength(1);
    expect(existsSync(join(host.dir, 'outside.mp4'))).toBe(false);
  });

  it('refuses a location nobody approved', async () => {
    const target = join(host.dir, 'elsewhere', 'clip.mp4');
    const refused = await postJson(host, '/files', { name: 'clip.mp4', outputPath: target });
    expect(refused.status).toBe(403);
    expect(existsSync(target)).toBe(false);
  });

  it('deletes the partial file when an export is cancelled', async () => {
    const created = await postJson(host, '/files', { name: 'partial.mp4' });
    const socket = await Socket.open(host, String(created.body.id));
    const chunk = positioned(0, Buffer.alloc(1024, 1));
    socket.send(chunk);
    await socket.drain(chunk.length);
    const path = join(host.dir, 'exports', 'partial.mp4');
    expect(existsSync(path)).toBe(true);

    const cancelled = await call(host, `/sessions/${String(created.body.id)}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect(existsSync(path)).toBe(false);
    expect(host.written).toEqual([]);
  });

  it('confirms progress so the sender can pace itself', async () => {
    const created = await postJson(host, '/files', { name: 'big.mp4' });
    const socket = await Socket.open(host, String(created.body.id));
    const payload = Buffer.alloc(3 * 1024 * 1024, 5);
    let sent = 0;
    for (let i = 0; i < 4; i++) {
      const message = positioned(i * payload.length, payload);
      socket.send(message);
      sent += message.length;
    }
    await socket.drain(sent);
    expect(socket.confirmed).toBe(sent);
    socket.close();
    const done = await postJson(host, `/sessions/${String(created.body.id)}/finish`, {});
    expect(done.body.bytes).toBe(4 * payload.length);
  });
});

describe('ExportBridge with a token', () => {
  const token = 'secret-for-this-run';
  let host: Host;
  beforeEach(async () => {
    host = await startHost({ token });
  });
  afterEach(async () => {
    await host.close();
  });

  it('refuses requests without the token', async () => {
    expect((await call(host, '/info')).status).toBe(403);
    expect((await call(host, '/info', { token: 'wrong' })).status).toBe(403);
    expect((await call(host, '/info', { token })).status).toBe(200);
  });

  it('refuses sockets without the token', async () => {
    const created = await postJson(host, '/files', { name: 'clip.mp4' }, token);
    const id = String(created.body.id);
    await expect(Socket.open(host, id)).rejects.toThrow();
    const socket = await Socket.open(host, id, `?token=${token}`);
    socket.close();
  });
});

describe('ExportBridge with approved locations', () => {
  it('writes to a location the host approved, once', async () => {
    const approved = new Set<string>();
    const host = await startHost({ claimOutputPath: (path) => approved.delete(path) });
    try {
      const target = join(host.dir, 'picked', 'my clip.mp4');
      approved.add(target);

      const created = await postJson(host, '/files', { name: 'ignored.mp4', outputPath: target });
      expect(created.status).toBe(200);
      expect(created.body.fileName).toBe('my clip.mp4');
      const done = await postJson(host, `/sessions/${String(created.body.id)}/finish`, {});
      expect(done.body.path).toBe(target);
      expect(existsSync(target)).toBe(true);

      // The approval was used up.
      const again = await postJson(host, '/files', { name: 'ignored.mp4', outputPath: target });
      expect(again.status).toBe(403);
    } finally {
      await host.close();
    }
  });

  it('refuses an approved location with the wrong file type', async () => {
    const host = await startHost({ claimOutputPath: () => true });
    try {
      const target = join(host.dir, 'picked', 'clip.exe');
      const refused = await postJson(host, '/files', { name: 'clip.mp4', outputPath: target });
      expect(refused.status).toBe(403);
    } finally {
      await host.close();
    }
  });
});

describe.skipIf(!hasFfmpeg)('ExportBridge encoding', () => {
  it('turns raw frames into a video file', async () => {
    const host = await startHost();
    try {
      const width = 64;
      const height = 36;
      const frames = 12;
      const created = await postJson(host, '/sessions', {
        width,
        height,
        fps: 30,
        codec: 'libx264',
        name: 'frames',
      });
      expect(created.status).toBe(200);
      const id = String(created.body.id);
      expect((await postJson(host, `/sessions/${id}/start`, {})).status).toBe(200);

      const socket = await Socket.open(host, id);
      const frame = Buffer.alloc(width * height * 4);
      for (let i = 0; i < frames; i++) {
        frame.fill(i * 20);
        socket.send(frame);
      }
      await socket.drain(frames * frame.length);
      expect(socket.failure).toBeNull();
      socket.close();

      const done = await postJson(host, `/sessions/${id}/finish`, {});
      expect(done.status).toBe(200);
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', String(done.body.path)],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(probe.stdout.trim()).toBe(`${width},${height},${frames}`);
    } finally {
      await host.close();
    }
  }, 30_000);

  it('rejects codecs and sizes it cannot handle', async () => {
    const host = await startHost();
    try {
      const base = { width: 64, height: 36, fps: 30, name: 'x' };
      expect((await postJson(host, '/sessions', { ...base, codec: 'nonsense' })).status).toBe(400);
      expect((await postJson(host, '/sessions', { ...base, codec: 'libx264', width: 4 })).status).toBe(400);
      expect((await postJson(host, '/sessions', { ...base, codec: 'libx264', fps: 0 })).status).toBe(400);
    } finally {
      await host.close();
    }
  });
});

describe('ExportBridge without FFmpeg', () => {
  it('says so instead of failing later', async () => {
    const host = await startHost({ ffmpegPaths: ['this-ffmpeg-does-not-exist'] });
    try {
      const info = await call(host, '/info');
      expect(info.body.available).toBe(false);
      const created = await postJson(host, '/sessions', {
        width: 64,
        height: 36,
        fps: 30,
        codec: 'libx264',
        name: 'x',
      });
      expect(created.status).toBe(503);
    } finally {
      await host.close();
    }
  });

  it('uses the first candidate that works', async () => {
    const host = await startHost({ ffmpegPaths: ['this-ffmpeg-does-not-exist', 'ffmpeg'] });
    try {
      expect(host.bridge.ffmpeg.path).toBe(hasFfmpeg ? 'ffmpeg' : null);
    } finally {
      await host.close();
    }
  });
});
