/**
 * Client side of the export bridge (see tools/exportBridge.ts).
 * Control messages use HTTP. Bulk data uses a WebSocket with a sliding window, so an export
 * of any length needs a fixed amount of memory on both ends.
 */

import { desktop } from '../platform/desktop';

const API = '/api/bridge';
const TOKEN_HEADER = 'x-bridge-token';
/** At most this much data may be on its way without the server having confirmed it. */
const WINDOW_BYTES = 64 * 1024 * 1024;
/** Size of the position header in front of every chunk of a stored file. */
export const POSITION_HEADER_BYTES = 8;

export interface BridgeCodec {
  id: string;
  label: string;
  extension: string;
  usesBitrate: boolean;
}

export interface BridgeInfo {
  available: boolean;
  version: string | null;
  exportDir: string;
  codecs: BridgeCodec[];
}

export interface BridgeFile {
  path: string;
  fileName: string;
  bytes: number;
}

export async function bridgeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // The desktop shell only serves requests that carry its secret.
  if (desktop) headers.set(TOKEN_HEADER, desktop.bridgeToken);
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Export bridge error ${response.status}`);
  return body;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return bridgeRequest<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Asks the local server whether FFmpeg is available. Resolves to null when there is no bridge. */
export async function probeBridge(): Promise<BridgeInfo | null> {
  try {
    const info = await bridgeRequest<BridgeInfo>('/info');
    return info.available ? info : null;
  } catch {
    return null;
  }
}

/** The data channel of one bridge session. */
export class BridgeSocket {
  private sent = 0;
  private confirmed = 0;
  private failure: Error | null = null;
  private waiters: Array<() => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const [kind, ...rest] = String(event.data).split(' ');
      if (kind === 'ack' || kind === 'flushed') this.confirmed = Number(rest[0]);
      else if (kind === 'error') this.failure = new Error(rest.join(' ') || 'The export bridge failed.');
      this.wake();
    });
    socket.addEventListener('close', () => {
      this.failure ??= new Error('The connection to the export bridge was lost.');
      this.wake();
    });
  }

  static open(sessionId: string): Promise<BridgeSocket> {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    // Browsers cannot set headers on a socket, so the secret travels in the address.
    const query = desktop ? `?token=${encodeURIComponent(desktop.bridgeToken)}` : '';
    const socket = new WebSocket(
      `${scheme}://${location.host}${API}/sessions/${sessionId}/socket${query}`,
    );
    socket.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(new BridgeSocket(socket)), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Could not connect to the export bridge.')),
        { once: true },
      );
    });
  }

  /**
   * Sends one chunk. The bytes are copied at once, so the caller may reuse its buffer.
   * Resolves as soon as the unconfirmed amount is inside the window, which paces the sender
   * to whatever the encoder and the disk can take.
   */
  async send(data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.failure) throw this.failure;
    this.socket.send(data);
    this.sent += data.byteLength;
    while (this.sent - this.confirmed > WINDOW_BYTES) {
      await this.nextMessage();
      if (this.failure) throw this.failure;
    }
  }

  /** Resolves when the server has written everything that was sent. */
  async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    this.socket.send('end');
    while (this.confirmed < this.sent) {
      await this.nextMessage();
      if (this.failure) throw this.failure;
    }
  }

  close(): void {
    // A deliberate close is not a failure.
    this.failure ??= new Error('The export bridge connection is closed.');
    this.socket.close();
  }

  private nextMessage(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
