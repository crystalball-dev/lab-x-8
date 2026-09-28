import { describe, expect, it } from 'vitest';
import { ParamStore, hexToLinear } from '../src/params/ParamStore';
import { PALETTES, renderPalette } from '../src/params/palettes';
import { MOD_SOURCES, MOD_SOURCE_INDEX, type ParamGroup } from '../src/params/types';

const LOOK: ParamGroup = {
  id: 'look',
  label: 'Look',
  params: [
    { key: 'amount', label: 'Amount', type: 'float', min: 0, max: 2, default: 0.5 },
    { key: 'driven', label: 'Driven', type: 'float', min: 0, max: 1, default: 0.2, mod: { source: 'bass', amount: 0.5 } },
    { key: 'count', label: 'Count', type: 'int', min: 1, max: 8, default: 4 },
    { key: 'on', label: 'On', type: 'bool', default: false },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'b',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
    },
    { key: 'tint', label: 'Tint', type: 'color', default: '#ff8000' },
  ],
};

const MACHINE: ParamGroup = {
  id: 'machine',
  label: 'Machine',
  preset: false,
  params: [{ key: 'bpm', label: 'BPM', type: 'float', min: 60, max: 220, default: 174 }],
};

function createStore(): ParamStore {
  const store = new ParamStore();
  store.register(LOOK);
  store.register(MACHINE);
  return store;
}

function sources(values: Partial<Record<keyof typeof MOD_SOURCE_INDEX, number>>): Float32Array {
  const out = new Float32Array(MOD_SOURCES.length);
  for (const [id, value] of Object.entries(values)) {
    out[MOD_SOURCE_INDEX[id as keyof typeof MOD_SOURCE_INDEX]] = value!;
  }
  return out;
}

describe('ParamStore values', () => {
  it('starts at the defaults', () => {
    const store = createStore();
    expect(store.get('look.amount')).toBe(0.5);
    expect(store.num('look.count')).toBe(4);
    expect(store.bool('look.on')).toBe(false);
    expect(store.str('look.mode')).toBe('b');
  });

  it('clamps and coerces what it is given', () => {
    const store = createStore();
    store.set('look.amount', 99);
    expect(store.get('look.amount')).toBe(2);
    store.set('look.count', 3.6);
    expect(store.get('look.count')).toBe(4);
    store.set('look.amount', Number.NaN);
    expect(store.get('look.amount')).toBe(0.5);
    store.set('look.mode', 'nonsense');
    expect(store.get('look.mode')).toBe('b');
    store.set('look.tint', 'red');
    expect(store.get('look.tint')).toBe('#ff8000');
  });

  it('exposes selects as option indices and booleans as 0 or 1', () => {
    const store = createStore();
    expect(store.num('look.mode')).toBe(1);
    store.set('look.mode', 'c');
    expect(store.num('look.mode')).toBe(2);
    store.set('look.on', true);
    expect(store.num('look.on')).toBe(1);
  });

  it('converts colours to linear light', () => {
    const store = createStore();
    const [r, g, b] = store.rgb('look.tint');
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(hexToLinear('#008000')[1], 5);
    expect(b).toBe(0);
  });

  it('rejects unknown parameters', () => {
    expect(() => createStore().get('look.missing')).toThrow();
  });

  it('notifies listeners once per change', () => {
    const store = createStore();
    const seen: string[] = [];
    store.subscribe((path) => seen.push(path));
    store.set('look.amount', 1);
    store.set('look.amount', 1);
    expect(seen).toEqual(['look.amount']);
  });
});

describe('ParamStore modulation', () => {
  it('adds the source scaled by the range and the depth', () => {
    const store = createStore();
    store.applyModulation(sources({ bass: 1 }));
    expect(store.num('look.driven')).toBeCloseTo(0.7, 6);
    store.applyModulation(sources({ bass: 0.5 }));
    expect(store.num('look.driven')).toBeCloseTo(0.45, 6);
    // The stored value is untouched.
    expect(store.get('look.driven')).toBe(0.2);
  });

  it('keeps the result inside the parameter range', () => {
    const store = createStore();
    store.setMod('look.driven', { source: 'kick', amount: 1 });
    store.applyModulation(sources({ kick: 1.5 }));
    expect(store.num('look.driven')).toBe(1);
    store.setMod('look.driven', { source: 'kick', amount: -1 });
    store.applyModulation(sources({ kick: 1.5 }));
    expect(store.num('look.driven')).toBe(0);
  });

  it('stops modulating when the route is removed', () => {
    const store = createStore();
    store.setMod('look.driven', null);
    store.applyModulation(sources({ bass: 1 }));
    expect(store.num('look.driven')).toBe(0.2);
  });

  it('only lets the audio drive parameters of the look', () => {
    const store = createStore();
    expect(store.canModulate('look.amount')).toBe(true);
    expect(store.canModulate('look.count')).toBe(false);
    expect(store.canModulate('machine.bpm')).toBe(false);
    store.setMod('machine.bpm', { source: 'bass', amount: 1 });
    expect(store.getMod('machine.bpm')).toBeNull();
  });
});

describe('ParamStore presets', () => {
  it('round-trips a snapshot', () => {
    const a = createStore();
    a.set('look.amount', 1.25);
    a.set('look.mode', 'c');
    a.set('look.on', true);
    a.setMod('look.amount', { source: 'hat', amount: -0.3 });
    a.setMod('look.driven', null);

    const b = createStore();
    b.load(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.get('look.amount')).toBe(1.25);
    expect(b.get('look.mode')).toBe('c');
    expect(b.get('look.on')).toBe(true);
    expect(b.getMod('look.amount')).toEqual({ source: 'hat', amount: -0.3 });
    // A removed default route stays removed.
    expect(b.getMod('look.driven')).toBeNull();
  });

  it('returns unmentioned parameters to their defaults', () => {
    const store = createStore();
    store.set('look.amount', 2);
    store.set('look.count', 8);
    store.load({ version: 1, values: { 'look.count': 2 } });
    expect(store.get('look.amount')).toBe(0.5);
    expect(store.get('look.count')).toBe(2);
    expect(store.getMod('look.driven')).toEqual({ source: 'bass', amount: 0.5 });
  });

  it('leaves machine settings alone', () => {
    const store = createStore();
    store.set('machine.bpm', 128);
    expect(store.snapshot().values['machine.bpm']).toBeUndefined();
    store.load({ version: 1, values: { 'machine.bpm': 90, 'look.amount': 1 } });
    expect(store.get('machine.bpm')).toBe(128);
    // Unless the whole state is being restored.
    store.load({ version: 1, values: { 'machine.bpm': 90 } }, { includeSystem: true });
    expect(store.get('machine.bpm')).toBe(90);
  });

  it('ignores unknown entries and repairs invalid ones', () => {
    const store = createStore();
    store.load({
      version: 1,
      values: { 'gone.param': 3, 'look.amount': 'loud' as unknown as number, 'look.count': 100 },
      mods: { 'look.amount': { source: 'nope' as 'bass', amount: 4 } },
    });
    expect(store.get('look.amount')).toBe(0.5);
    expect(store.get('look.count')).toBe(8);
    expect(store.getMod('look.amount')).toBeNull();
  });

  it('randomizes inside the allowed range and skips machine settings', () => {
    const store = createStore();
    let seed = 1;
    const rng = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 50; i++) {
      store.randomize(rng, () => true);
      const amount = store.get('look.amount') as number;
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(amount).toBeLessThanOrEqual(2);
      expect(Number.isInteger(store.get('look.count'))).toBe(true);
      expect(store.get('machine.bpm')).toBe(174);
    }
  });
});

describe('Palettes', () => {
  it('renders the first and last stop at the ends of the gradient', () => {
    const data = renderPalette(['#ff0000', '#00ff00', '#0000ff'], 256);
    expect(Array.from(data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(data.subarray(255 * 4))).toEqual([0, 0, 255, 255]);
    // The middle stop sits in the middle.
    const mid = Array.from(data.subarray(127 * 4, 127 * 4 + 3));
    expect(mid[1]).toBeGreaterThan(250);
  });

  it('handles a single stop', () => {
    const data = renderPalette(['#123456'], 8);
    for (let i = 0; i < 8; i++) {
      expect(Array.from(data.subarray(i * 4, i * 4 + 4))).toEqual([0x12, 0x34, 0x56, 255]);
    }
  });

  it('ships palettes with valid colours', () => {
    expect(PALETTES.length).toBeGreaterThan(5);
    for (const palette of PALETTES) {
      expect(palette.stops.length).toBeGreaterThanOrEqual(2);
      for (const stop of palette.stops) expect(stop).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
