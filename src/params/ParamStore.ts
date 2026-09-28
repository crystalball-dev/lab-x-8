import { clamp } from '../util/math';
import {
  MOD_SOURCE_INDEX,
  type ModRoute,
  type ParamDef,
  type ParamGroup,
  type ParamValue,
  type PresetData,
} from './types';

interface Entry {
  path: string;
  def: ParamDef;
  group: ParamGroup;
  value: ParamValue;
  mod: ModRoute | null;
  /** Numeric value seen by the renderer, after modulation. */
  effective: number;
  /** Linear RGB, only for colour parameters. */
  rgb: [number, number, number] | null;
}

/** `path` is the parameter that changed, or `*` after a bulk change such as loading a preset. */
export type ParamListener = (path: string) => void;

export interface SnapshotOptions {
  /** Include groups flagged `preset: false` (machine and venue settings). */
  includeSystem?: boolean;
}

/**
 * Single source of truth for every parameter value and modulation route.
 *
 * Reads on the render path (`num`, `rgb`) are plain map lookups of precomputed numbers.
 */
export class ParamStore {
  readonly groups: ParamGroup[] = [];
  private readonly entries = new Map<string, Entry>();
  private modulated: Entry[] = [];
  private readonly listeners = new Set<ParamListener>();

  register(group: ParamGroup): void {
    if (this.groups.some((g) => g.id === group.id)) {
      throw new Error(`Parameter group "${group.id}" is already registered.`);
    }
    this.groups.push(group);
    for (const def of group.params) {
      const path = `${group.id}.${def.key}`;
      const entry: Entry = {
        path,
        def,
        group,
        value: def.default,
        mod: def.type === 'float' && def.mod ? { ...def.mod } : null,
        effective: 0,
        rgb: null,
      };
      this.entries.set(path, entry);
      this.refresh(entry);
    }
    this.rebuildModulated();
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  def(path: string): ParamDef {
    return this.entry(path).def;
  }

  /** The stored (unmodulated) value. */
  get(path: string): ParamValue {
    return this.entry(path).value;
  }

  /**
   * The numeric value used for rendering: modulated floats, 0/1 for booleans and the option
   * index for selects.
   */
  num(path: string): number {
    return this.entry(path).effective;
  }

  bool(path: string): boolean {
    return this.entry(path).value === true;
  }

  str(path: string): string {
    return String(this.entry(path).value);
  }

  /** Linear RGB of a colour parameter. */
  rgb(path: string): [number, number, number] {
    return this.entry(path).rgb ?? [0, 0, 0];
  }

  getMod(path: string): ModRoute | null {
    return this.entry(path).mod;
  }

  /**
   * Whether the audio may drive this parameter. Only numeric parameters of the look can be
   * modulated. Settings that describe the machine or the music, such as the tempo, cannot.
   */
  canModulate(path: string): boolean {
    const entry = this.entry(path);
    return entry.def.type === 'float' && entry.group.preset !== false;
  }

  set(path: string, value: ParamValue): void {
    const entry = this.entry(path);
    const next = coerce(entry.def, value);
    if (next === entry.value) return;
    entry.value = next;
    this.refresh(entry);
    this.emit(path);
  }

  setMod(path: string, route: ModRoute | null): void {
    const entry = this.entry(path);
    if (!this.canModulate(path)) return;
    entry.mod =
      route && route.source !== 'none' && route.amount !== 0
        ? { source: route.source, amount: clamp(route.amount, -1, 1) }
        : null;
    this.refresh(entry);
    this.rebuildModulated();
    this.emit(path);
  }

  /**
   * Recomputes every modulated parameter. Call once per frame.
   * @param sources one value per entry of MOD_SOURCES
   */
  applyModulation(sources: Float32Array): void {
    for (const entry of this.modulated) {
      const def = entry.def;
      if (def.type !== 'float' || !entry.mod) continue;
      const signal = sources[MOD_SOURCE_INDEX[entry.mod.source]] ?? 0;
      entry.effective = clamp(
        (entry.value as number) + entry.mod.amount * signal * (def.max - def.min),
        def.min,
        def.max,
      );
    }
  }

  reset(path: string): void {
    const entry = this.entry(path);
    entry.value = entry.def.default;
    entry.mod = entry.def.type === 'float' && entry.def.mod ? { ...entry.def.mod } : null;
    this.refresh(entry);
    this.rebuildModulated();
    this.emit(path);
  }

  resetGroup(groupId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.group.id !== groupId) continue;
      entry.value = entry.def.default;
      entry.mod = entry.def.type === 'float' && entry.def.mod ? { ...entry.def.mod } : null;
      this.refresh(entry);
    }
    this.rebuildModulated();
    this.emit('*');
  }

  snapshot(options: SnapshotOptions = {}): PresetData {
    const values: Record<string, ParamValue> = {};
    const mods: Record<string, ModRoute> = {};
    for (const entry of this.entries.values()) {
      if (entry.group.preset === false && !options.includeSystem) continue;
      values[entry.path] = entry.value;
      // An explicit `none` route records that a default route was removed.
      if (entry.mod) mods[entry.path] = { ...entry.mod };
      else if (entry.def.type === 'float' && entry.def.mod) {
        mods[entry.path] = { source: 'none', amount: 0 };
      }
    }
    return { version: 1, values, mods };
  }

  /**
   * Applies a preset. Parameters the preset does not mention return to their defaults, so a
   * preset always produces the same look regardless of what was on screen before.
   */
  load(preset: PresetData, options: SnapshotOptions = {}): void {
    for (const entry of this.entries.values()) {
      if (entry.group.preset === false && !options.includeSystem) continue;
      const def = entry.def;
      const value = preset.values[entry.path];
      entry.value = value === undefined ? def.default : coerce(def, value);
      const route = preset.mods?.[entry.path];
      if (def.type !== 'float') entry.mod = null;
      else if (route === undefined) entry.mod = def.mod ? { ...def.mod } : null;
      else if (route.source === 'none' || !(route.source in MOD_SOURCE_INDEX)) entry.mod = null;
      else entry.mod = { source: route.source, amount: clamp(Number(route.amount) || 0, -1, 1) };
      this.refresh(entry);
    }
    this.rebuildModulated();
    this.emit('*');
  }

  /**
   * Randomizes the look.
   * @param rng     returns uniform values in 0..1
   * @param filter  restricts which parameters may change
   */
  randomize(rng: () => number, filter: (path: string, group: ParamGroup) => boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.group.preset === false || !filter(entry.path, entry.group)) continue;
      const def = entry.def;
      switch (def.type) {
        case 'float':
        case 'int': {
          if (def.rand === false) break;
          const [lo, hi] = def.rand ?? [def.min, def.max];
          entry.value = coerce(def, lo + (hi - lo) * rng());
          break;
        }
        case 'bool':
          if (def.rand) entry.value = rng() < 0.5;
          break;
        case 'select':
          if (def.rand) {
            entry.value = def.options[Math.floor(rng() * def.options.length)]!.value;
          }
          break;
        case 'color':
          break;
      }
      this.refresh(entry);
    }
    this.emit('*');
  }

  subscribe(listener: ParamListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private entry(path: string): Entry {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`Unknown parameter "${path}".`);
    return entry;
  }

  private emit(path: string): void {
    for (const listener of this.listeners) listener(path);
  }

  private rebuildModulated(): void {
    this.modulated = [...this.entries.values()].filter((e) => e.mod !== null);
  }

  /** Recomputes the cached render-side representation of an entry. */
  private refresh(entry: Entry): void {
    const { def, value } = entry;
    switch (def.type) {
      case 'float':
      case 'int':
        entry.effective = value as number;
        break;
      case 'bool':
        entry.effective = value ? 1 : 0;
        break;
      case 'select':
        entry.effective = Math.max(
          0,
          def.options.findIndex((o) => o.value === value),
        );
        break;
      case 'color':
        entry.rgb = hexToLinear(String(value));
        entry.effective = 0;
        break;
    }
  }
}

function coerce(def: ParamDef, value: ParamValue): ParamValue {
  switch (def.type) {
    case 'float': {
      const n = Number(value);
      return Number.isFinite(n) ? clamp(n, def.min, def.max) : def.default;
    }
    case 'int': {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? clamp(n, def.min, def.max) : def.default;
    }
    case 'bool':
      return value === true || value === 'true' || value === 1;
    case 'select':
      return def.options.some((o) => o.value === value) ? String(value) : def.default;
    case 'color':
      return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : def.default;
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function hexToLinear(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}
