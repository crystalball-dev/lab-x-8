import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface SettingsData {
  version: 1;
  /** What the app stores: current look, presets, panel layout. Keys and values are strings. */
  values: Record<string, string>;
  window?: WindowState;
}

const WRITE_DELAY_MS = 300;

/**
 * The settings file. Everything the app remembers lives in this one readable JSON file,
 * so it can be backed up, copied to another machine, or deleted to start fresh.
 */
export class SettingsFile {
  private data: SettingsData = { version: 1, values: {} };
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SettingsData>;
      if (parsed && typeof parsed.values === 'object' && parsed.values !== null) {
        this.data = { version: 1, values: {}, window: parsed.window };
        for (const [key, value] of Object.entries(parsed.values)) {
          if (typeof value === 'string') this.data.values[key] = value;
        }
      }
    } catch {
      // Keep the unreadable file for inspection and start with defaults.
      try {
        renameSync(path, `${path}.unreadable`);
      } catch {
        // Nothing more to do. The file is replaced on the next write.
      }
    }
  }

  get values(): Record<string, string> {
    return { ...this.data.values };
  }

  get window(): WindowState | undefined {
    return this.data.window;
  }

  set window(state: WindowState | undefined) {
    this.data.window = state;
    this.schedule();
  }

  /** Stores a value, or removes the key when `value` is null. */
  setValue(key: string, value: string | null): void {
    if (value === null) delete this.data.values[key];
    else this.data.values[key] = value;
    this.schedule();
  }

  /** Writes pending changes now. Call before the app quits. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Write beside the target and swap, so a crash never leaves half a file.
      const temporary = `${this.path}.writing`;
      writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(temporary, this.path);
    } catch (error) {
      console.error('Could not write settings:', error);
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_DELAY_MS);
  }
}
