/**
 * Export bridge: gives the renderer two things it cannot do on its own.
 *
 *   encode  raw frames are piped into FFmpeg, which unlocks the codecs browsers cannot write
 *           and VJ software prefers: ProRes, HAP, and high quality H.264 / HEVC
 *   store   a file encoded in the renderer is written straight to disk
 *
 * Control messages travel over HTTP. Bulk data travels over a WebSocket with flow control, so
 * memory use stays flat however long the export is.
 *
 * The bridge has no server of its own. A host hands it requests and socket upgrades: the Vite
 * development server (tools/exportBridge.ts) or the desktop shell (electron/server.ts).
 * It accepts requests only from the page its host serves.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { ALLOWED_EXTENSIONS, FFMPEG_CODECS, type CodecSpec } from './codecs';

export const BRIDGE_PREFIX = '/api/bridge';
export const TOKEN_HEADER = 'x-bridge-token';
const SOCKET_PATH = /^\/api\/bridge\/sessions\/([\w-]+)\/socket$/;
/** The client is told how much has been written every time this many bytes went through. */
const ACK_INTERVAL = 4 * 1024 * 1024;
/** A session whose socket closed without finishing is cleaned up after this long. */
const ORPHAN_TIMEOUT_MS = 30_000;
/** Size of the position header in front of every chunk of a `store` session. */
export const POSITION_HEADER_BYTES = 8;

export interface ExportBridgeOptions {
  /** Folder that receives exported files unless the user picked another place. */
  exportDir: string;
  /** FFmpeg executables to try, in order. The first one that runs is used. */
  ffmpegPaths?: string[];
  /** When set, every request has to present this secret. */
  token?: string;
  /**
   * Asked once for every absolute output path a request wants to write to.
   * The desktop shell answers yes only for paths the user chose in a save dialog.
   * Without it, the bridge writes into `exportDir` only.
   */
  claimOutputPath?: (path: string) => boolean;
  /** Told about every file that was completed. */
  onFileWritten?: (path: string) => void;
}

export interface FfmpegInfo {
  path: string | null;
  version: string | null;
  encoders: Set<string>;
}

interface EncodeSettings {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
}

interface Session {
  id: string;
  kind: 'encode' | 'store';
  outputPath: string;
  fileName: string;
  /** Bytes of socket messages that have been handed to FFmpeg or the file. */
  written: number;
  acked: number;
  /** Serializes writes so they happen in the order they arrived. */
  queue: Promise<void>;
  failure: string | null;
  socket: WebSocket | null;
  orphanTimer: NodeJS.Timeout | null;
  finished: boolean;

  // encode
  settings: EncodeSettings | null;
  spec: CodecSpec | null;
  audioPath: string | null;
  process: ChildProcessWithoutNullStreams | null;
  exit: Promise<number> | null;
  log: string[];

  // store
  file: FileHandle | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function safeName(name: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'export';
}

/** Runs the first FFmpeg candidate that works and lists its encoders. */
export function probeFfmpeg(candidates: string[]): FfmpegInfo {
  for (const path of candidates) {
    const version = spawnSync(path, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (version.status !== 0 || !version.stdout) continue;
    const list = spawnSync(path, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const encoders = new Set<string>();
    for (const line of (list.stdout ?? '').split('\n')) {
      const match = /^\s*[VAS][.\w]{5}\s+(\S+)/.exec(line);
      if (match) encoders.add(match[1]!);
    }
    return { path, version: version.stdout.split('\n')[0]!.trim(), encoders };
  }
  return { path: null, version: null, encoders: new Set() };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** Finds a file name inside `dir` that does not exist yet. */
function uniquePath(dir: string, base: string, extension: string): { path: string; fileName: string } {
  for (let i = 0; ; i++) {
    const fileName = i === 0 ? `${base}.${extension}` : `${base} (${i}).${extension}`;
    const path = join(dir, fileName);
    if (!existsSync(path)) return { path, fileName };
  }
}

/** Deletes a file, retrying while another process still holds it open. */
async function removeFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      rmSync(path, { force: true });
      return;
    } catch {
      await delay(200);
    }
  }
}

export class ExportBridge {
  readonly exportDir: string;
  private readonly tempDir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });
  private probed: FfmpegInfo | null = null;

  constructor(private readonly options: ExportBridgeOptions) {
    this.exportDir = resolve(options.exportDir);
    this.tempDir = join(this.exportDir, '.tmp');
  }

  /** The FFmpeg in use. Probed on first access. */
  get ffmpeg(): FfmpegInfo {
    return (this.probed ??= probeFfmpeg(this.options.ffmpegPaths ?? ['ffmpeg']));
  }

  /**
   * Handles the request when it is addressed to the bridge.
   * @returns false when the request belongs to someone else
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? '';
    if (!url.startsWith(BRIDGE_PREFIX)) return false;
    if (!this.isTrusted(req)) {
      sendJson(res, 403, { error: 'The export bridge only accepts requests from this app.' });
      return true;
    }
    const path = url.slice(BRIDGE_PREFIX.length).split('?')[0] ?? '';
    this.route(req, res, path).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    });
    return true;
  }

  /**
   * Accepts the socket when it is addressed to the bridge.
   * @returns false when the upgrade belongs to someone else, such as a hot reload socket
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const match = SOCKET_PATH.exec((req.url ?? '').split('?')[0] ?? '');
    if (!match) return false;
    const session = this.sessions.get(match[1]!);
    const ready = session && (session.kind === 'store' || session.process !== null);
    if (!this.isTrusted(req) || !session || !ready || session.socket) {
      socket.destroy();
      return true;
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => this.attachSocket(session, ws));
    return true;
  }

  /** Stops every running export and deletes its partial output. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s, true)));
    this.sockets.close();
  }

  /**
   * Rejects requests made by other web pages or other programs. The bridge writes files and
   * starts FFmpeg, so it must only ever be driven by the app it belongs to.
   */
  private isTrusted(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      try {
        if (new URL(origin).host !== req.headers.host) return false;
      } catch {
        return false;
      }
    }
    const token = this.options.token;
    if (token) {
      const header = req.headers[TOKEN_HEADER];
      const query = new URL(req.url ?? '', 'http://bridge').searchParams.get('token');
      if (header !== token && query !== token) return false;
    }
    return true;
  }

  /**
   * Decides where a session writes. A requested absolute path is honoured only when the host
   * confirms that the user picked it.
   */
  private resolveTarget(
    requested: unknown,
    name: string,
    extension: string,
  ): { path: string; fileName: string } | { error: string } {
    if (typeof requested === 'string' && requested.length > 0) {
      const path = resolve(requested);
      const granted =
        isAbsolute(requested) &&
        extname(path).slice(1).toLowerCase() === extension &&
        this.options.claimOutputPath?.(path) === true;
      if (!granted) return { error: 'This location was not chosen in a save dialog.' };
      mkdirSync(dirname(path), { recursive: true });
      return { path, fileName: path.split(/[\\/]/).pop() ?? name };
    }
    mkdirSync(this.exportDir, { recursive: true });
    return uniquePath(this.exportDir, name, extension);
  }

  private createSession(kind: Session['kind'], target: { path: string; fileName: string }): Session {
    const session: Session = {
      id: randomUUID(),
      kind,
      outputPath: target.path,
      fileName: target.fileName,
      written: 0,
      acked: 0,
      queue: Promise.resolve(),
      failure: null,
      socket: null,
      orphanTimer: null,
      finished: false,
      settings: null,
      spec: null,
      audioPath: null,
      process: null,
      exit: null,
      log: [],
      file: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Releases everything a session holds. With `discard` the partial output is deleted too. */
  private async closeSession(session: Session, discard: boolean): Promise<void> {
    this.sessions.delete(session.id);
    session.finished = true;
    if (session.orphanTimer) clearTimeout(session.orphanTimer);
    session.socket?.close();
    const child = session.process;
    if (child && child.exitCode === null) {
      child.kill();
      // On Windows the output file stays locked until the process is really gone.
      await Promise.race([session.exit, delay(4000)]);
    }
    if (session.file) {
      await session.file.close().catch(() => undefined);
      session.file = null;
    }
    if (session.audioPath) await removeFile(session.audioPath);
    if (discard) await removeFile(session.outputPath);
  }

  private fail(session: Session, message: string): void {
    if (session.failure) return;
    session.failure = message;
    if (session.socket?.readyState === 1) session.socket.send(`error ${message}`);
  }

  /** Hands one chunk to the session's sink, in arrival order, and acknowledges progress. */
  private accept(session: Session, data: Buffer): void {
    session.queue = session.queue
      .then(async () => {
        if (session.failure) return;
        if (session.kind === 'encode') {
          const child = session.process;
          if (!child || child.exitCode !== null) {
            throw new Error(`FFmpeg stopped. ${session.log.join('').slice(-600)}`);
          }
          await new Promise<void>((done, reject) => {
            child.stdin.write(data, (error) => (error ? reject(error) : done()));
          });
        } else {
          const position = Number(data.readBigUInt64LE(0));
          const payload = data.subarray(POSITION_HEADER_BYTES);
          await session.file!.write(payload, 0, payload.length, position);
        }
        // Progress counts whole messages, header included, to match what the client sent.
        session.written += data.length;
        if (session.written - session.acked >= ACK_INTERVAL && session.socket?.readyState === 1) {
          session.acked = session.written;
          session.socket.send(`ack ${session.written}`);
        }
      })
      .catch((error: unknown) =>
        this.fail(session, error instanceof Error ? error.message : String(error)),
      );
  }

  private attachSocket(session: Session, socket: WebSocket): void {
    session.socket = socket;
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.accept(session, data);
      } else if (data.toString() === 'end') {
        // Replies once everything that arrived before this message has been written.
        session.queue = session.queue.then(() => {
          if (socket.readyState !== 1) return;
          socket.send(session.failure ? `error ${session.failure}` : `flushed ${session.written}`);
        });
      }
    });
    socket.on('close', () => {
      session.socket = null;
      if (session.finished) return;
      // The page went away mid-export. Give it a moment to finish, then clean up.
      session.orphanTimer = setTimeout(() => {
        if (!session.finished) void this.closeSession(session, true);
      }, ORPHAN_TIMEOUT_MS);
    });
    socket.on('error', () => socket.close());
  }

  private startEncoder(session: Session): void {
    const s = session.settings!;
    const spec = session.spec!;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba',
      '-video_size', `${s.width}x${s.height}`, '-framerate', String(s.fps),
      '-i', 'pipe:0',
    ];
    if (session.audioPath) args.push('-i', session.audioPath);
    // WebGL rows run bottom to top, video rows top to bottom.
    args.push(
      '-vf',
      spec.yuv ? 'vflip,scale=in_range=full:out_range=tv:out_color_matrix=bt709' : 'vflip',
    );
    args.push(...spec.video(s.bitrate));
    if (spec.yuv) {
      args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
    }
    args.push('-r', String(s.fps));
    if (session.audioPath) args.push('-map', '0:v:0', '-map', '1:a:0', ...spec.audio, '-shortest');
    args.push(session.outputPath);

    const child = spawn(this.ffmpeg.path!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    session.process = child;
    child.stderr.on('data', (data: Buffer) => {
      session.log.push(data.toString('utf8'));
      if (session.log.length > 200) session.log.shift();
    });
    // A closed pipe is reported through the write callback instead of crashing the host.
    child.stdin.on('error', () => undefined);
    session.exit = new Promise((resolveExit) => {
      child.on('close', (code) => resolveExit(code ?? 1));
      child.on('error', (error) => {
        session.log.push(String(error));
        resolveExit(1);
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = path.split('/').filter(Boolean);

    if (method === 'GET' && parts[0] === 'info') {
      const { version, encoders } = this.ffmpeg;
      sendJson(res, 200, {
        available: version !== null,
        version,
        exportDir: this.exportDir,
        codecs: Object.entries(FFMPEG_CODECS)
          .filter(([, spec]) => encoders.has(spec.encoder))
          .map(([id, spec]) => ({
            id,
            label: spec.label,
            extension: spec.extension,
            usesBitrate: spec.usesBitrate,
            multipleOf: spec.multipleOf ?? 1,
          })),
      });
      return;
    }

    // Opens a file that the renderer then fills over the socket.
    if (method === 'POST' && parts[0] === 'files' && parts.length === 1) {
      const body = await readJson(req);
      const name = safeName(String(body.name ?? ''));
      const dot = name.lastIndexOf('.');
      const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        sendJson(res, 400, { error: `Files of type ".${extension}" are not accepted.` });
        return;
      }
      const target = this.resolveTarget(body.outputPath, name.slice(0, dot), extension);
      if ('error' in target) {
        sendJson(res, 403, target);
        return;
      }
      const session = this.createSession('store', target);
      session.file = await open(session.outputPath, 'w');
      sendJson(res, 200, { id: session.id, fileName: session.fileName });
      return;
    }

    if (method === 'POST' && parts[0] === 'sessions' && parts.length === 1) {
      const body = await readJson(req);
      const spec = FFMPEG_CODECS[String(body.codec)];
      const { version, encoders } = this.ffmpeg;
      if (version === null) {
        sendJson(res, 503, { error: 'FFmpeg was not found on this machine.' });
        return;
      }
      if (!spec || !encoders.has(spec.encoder)) {
        sendJson(res, 400, {
          error: `Codec "${String(body.codec)}" is not available in this FFmpeg build.`,
        });
        return;
      }
      const width = Number(body.width);
      const height = Number(body.height);
      const fps = Number(body.fps);
      const sizeOk = width >= 16 && width <= 8192 && height >= 16 && height <= 8192;
      if (!sizeOk || !(fps >= 1 && fps <= 240)) {
        sendJson(res, 400, { error: 'Invalid frame size or frame rate.' });
        return;
      }
      const block = spec.multipleOf ?? 1;
      if (width % block !== 0 || height % block !== 0) {
        sendJson(res, 400, { error: `${spec.label} needs a width and height divisible by ${block}.` });
        return;
      }
      const target = this.resolveTarget(
        body.outputPath,
        safeName(String(body.name ?? 'export')),
        spec.extension,
      );
      if ('error' in target) {
        sendJson(res, 403, target);
        return;
      }
      mkdirSync(this.tempDir, { recursive: true });
      const session = this.createSession('encode', target);
      session.spec = spec;
      session.settings = {
        width,
        height,
        fps,
        codec: String(body.codec),
        bitrate: Math.max(100_000, Number(body.bitrate) || 20_000_000),
      };
      sendJson(res, 200, { id: session.id, fileName: session.fileName });
      return;
    }

    const session = parts[0] === 'sessions' && parts[1] ? this.sessions.get(parts[1]) : undefined;
    if (!session) {
      sendJson(res, 404, { error: 'Unknown bridge endpoint or session.' });
      return;
    }
    const action = parts[2];

    if (method === 'PUT' && action === 'audio' && session.kind === 'encode') {
      if (session.process) {
        sendJson(res, 409, { error: 'Audio must be uploaded before encoding starts.' });
        return;
      }
      session.audioPath = join(this.tempDir, `${session.id}.wav`);
      await pipeline(req, createWriteStream(session.audioPath));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && action === 'start' && session.kind === 'encode') {
      if (!session.process) this.startEncoder(session);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && action === 'finish') {
      await session.queue;
      if (session.failure) {
        const message = session.failure;
        await this.closeSession(session, true);
        sendJson(res, 500, { error: message });
        return;
      }
      if (session.kind === 'encode') {
        const child = session.process;
        if (!child || !session.exit) {
          sendJson(res, 409, { error: 'Encoding was never started.' });
          return;
        }
        child.stdin.end();
        const code = await session.exit;
        if (code !== 0 || !existsSync(session.outputPath)) {
          const detail = session.log.join('').slice(-1200);
          await this.closeSession(session, true);
          sendJson(res, 500, { error: `FFmpeg failed (exit code ${code}). ${detail}` });
          return;
        }
      }
      await this.closeSession(session, false);
      this.options.onFileWritten?.(session.outputPath);
      sendJson(res, 200, {
        path: session.outputPath,
        fileName: session.fileName,
        bytes: statSync(session.outputPath).size,
      });
      return;
    }

    if (method === 'DELETE') {
      await this.closeSession(session, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Unknown bridge endpoint.' });
  }
}
