import { desktop, type DesktopApi } from '../platform/desktop';

/** Small persistent key-value store for settings, presets and layout. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Browser storage. It may be unavailable, for example in private windows. */
class BrowserStore implements KeyValueStore {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Without storage the session still works. It just is not remembered.
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // See above.
    }
  }
}

/** The settings file of the desktop application. Reads are served from memory. */
class DesktopStore implements KeyValueStore {
  private readonly cache: Map<string, string>;

  constructor(private readonly shell: DesktopApi) {
    this.cache = new Map(Object.entries(shell.readState()));
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    this.shell.writeState(key, value);
  }

  remove(key: string): void {
    if (!this.cache.delete(key)) return;
    this.shell.writeState(key, null);
  }
}

/** Keeps values for the lifetime of the process. Used where there is no storage at all. */
class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

function create(): KeyValueStore {
  if (desktop) return new DesktopStore(desktop);
  if (typeof localStorage !== 'undefined') return new BrowserStore();
  return new MemoryStore();
}

export const storage: KeyValueStore = create();
