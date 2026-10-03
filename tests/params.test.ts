import { describe, expect, it } from 'vitest';
import { ParamStore, hexToLinear } from '../src/params/ParamStore';
import { PALETTES, renderPalette } from '../src/params/palettes';
import { IMAGE_LAYERS } from '../src/effects/stages';
import { upgradePreset } from '../src/params/presets';
import { RESOLUTIONS, createParamStore, outputSize, parseResolution, randomizeLook } from '../src/params/schema';
import { createRng } from '../src/util/math';
import { MOD_SOURCES, MOD_SOURCE_INDEX, type ParamGroup, type PresetData } from '../src/params/types';

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

/** Like the image: only presets that store values for it change it. */
const PICTURE: ParamGroup = {
  id: 'picture',
  label: 'Picture',
  optional: true,
  params: [
    { key: 'size', label: 'Size', type: 'float', min: 0, max: 2, default: 1, mod: { source: 'kick', amount: 0.25 } },
    { key: 'spot', label: 'Spot', type: 'float', min: -1, max: 1, default: 0 },
  ],
};

function createStore(): ParamStore {
  const store = new ParamStore();
  store.register(LOOK);
  store.register(MACHINE);
  store.register(PICTURE);
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

  it('leaves optional groups alone when a preset stores nothing for them', () => {
    const store = createStore();
    store.set('picture.size', 0.3);
    store.set('picture.spot', 0.5);
    store.setMod('picture.size', { source: 'snare', amount: 0.5 });
    store.load({ version: 1, values: { 'look.amount': 1 } });
    expect(store.get('picture.size')).toBe(0.3);
    expect(store.get('picture.spot')).toBe(0.5);
    expect(store.getMod('picture.size')).toEqual({ source: 'snare', amount: 0.5 });
  });

  it('stores an optional group still at its defaults as its first value alone', () => {
    const store = createStore();
    expect(Object.keys(store.snapshot().values).filter((path) => path.startsWith('picture.'))).toEqual(['picture.size']);
    expect(store.snapshot().mods?.['picture.size']).toBeUndefined();

    // Loading that brings the group back to its defaults, as a full snapshot would.
    const untouched = store.snapshot();
    store.set('picture.spot', 0.5);
    store.load(untouched);
    expect(store.get('picture.spot')).toBe(0);

    // Once anything in it changes, a modulation route included, all of it is stored.
    store.setMod('picture.size', null);
    const changed = store.snapshot();
    expect(changed.values).toMatchObject({ 'picture.size': 1, 'picture.spot': 0 });
    expect(changed.mods?.['picture.size']).toEqual({ source: 'none', amount: 0 });
  });

  it('applies optional groups when the preset stores them, defaulting what it leaves out', () => {
    const store = createStore();
    store.set('picture.spot', 0.5);
    store.load({ version: 1, values: { 'picture.size': 2 } });
    expect(store.get('picture.size')).toBe(2);
    expect(store.get('picture.spot')).toBe(0);
    expect(store.getMod('picture.size')).toEqual({ source: 'kick', amount: 0.25 });
    expect(store.snapshot().values['picture.size']).toBe(2);
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

describe('Preset upgrade', () => {
  const legacy: PresetData = {
    version: 1,
    values: { 'layers.a': 'plasma', 'image.blend': 'under', 'image.kaleido': 12 },
    mods: { 'image.scale': { source: 'kick', amount: 0.02 } },
  };

  it('keeps the image of older presets in the scene, without the newer effects', () => {
    const upgraded = upgradePreset(legacy);
    expect(upgraded.values).toMatchObject({
      'layers.a': 'plasma',
      'image.placement': 'scene',
      'image.kaleido': 12,
      'image.glow': 0,
      'image.shadow': 0,
      'image.glitch': 0,
    });
    expect(upgraded.mods).toMatchObject({
      'image.scale': { source: 'kick', amount: 0.02 },
      'image.brightness': { source: 'none', amount: 0 },
      'image.glow': { source: 'none', amount: 0 },
    });
  });

  it('turns the old Base layer blend into Add, which drew the same', () => {
    expect(upgradePreset(legacy).values['image.blend']).toBe('add');
    const mask = { ...legacy, values: { ...legacy.values, 'image.blend': 'mask' } };
    expect(upgradePreset(mask).values['image.blend']).toBe('mask');
  });

  it('leaves current presets and presets without an image untouched', () => {
    const current: PresetData = { version: 1, values: { 'image.placement': 'top', 'image.glow': 0.8 } };
    expect(upgradePreset(current)).toBe(current);
    const noImage: PresetData = { version: 1, values: { 'layers.a': 'tunnel' } };
    expect(upgradePreset(noImage)).toBe(noImage);
  });
});

describe('Image layers', () => {
  it('number twenty, from image to image20', () => {
    expect(IMAGE_LAYERS).toHaveLength(20);
    expect(IMAGE_LAYERS[0]!.id).toBe('image');
    expect(IMAGE_LAYERS[19]!.id).toBe('image20');
    expect(new Set(IMAGE_LAYERS.map((layer) => layer.id)).size).toBe(20);
  });

  it('start in different places, so a new picture does not cover the ones before it', () => {
    const store = createParamStore();
    expect([store.get('image.x'), store.get('image.y'), store.get('image.scale')]).toEqual([0, 0, 0.8]);
    expect([store.get('image2.x'), store.get('image2.y'), store.get('image2.scale')]).toEqual([0.62, -0.68, 0.3]);
    expect([store.get('image3.x'), store.get('image4.y')]).toEqual([-0.62, 0.68]);
    expect([store.get('image5.x'), store.get('image5.y'), store.get('image5.scale')]).toEqual([-0.62, 0.68, 0.3]);

    const places = IMAGE_LAYERS.map((layer) => `${store.get(`${layer.id}.x`)},${store.get(`${layer.id}.y`)}`);
    expect(new Set(places).size).toBe(IMAGE_LAYERS.length);
    for (const layer of IMAGE_LAYERS.slice(5)) {
      expect(Math.abs(store.get(`${layer.id}.x`) as number)).toBeLessThanOrEqual(0.8);
      expect(Math.abs(store.get(`${layer.id}.y`) as number)).toBeLessThanOrEqual(0.8);
      expect(store.get(`${layer.id}.scale`)).toBe(0.2);
    }
  });

  it('keep presets small: a layer nobody has set up is one value', () => {
    const store = createParamStore();
    store.set('image7.x', 0.25);
    const values = Object.keys(store.snapshot().values);
    const perLayer = IMAGE_LAYERS[6]!.params.length;
    expect(values.filter((path) => path.startsWith('image7.'))).toHaveLength(perLayer);
    expect(values.filter((path) => path.startsWith('image8.'))).toEqual(['image8.placement']);
    expect(values.filter((path) => path.startsWith('image'))).toHaveLength(IMAGE_LAYERS.length - 1 + perLayer);
  });

  it('change places with their settings, and copy them', () => {
    const store = createParamStore();
    store.set('image2.x', -0.4);
    store.set('image2.visible', false);
    store.setMod('image2.scale', { source: 'snare', amount: 0.5 });
    store.set('image3.blend', 'screen');
    store.swapGroups('image2', 'image3');
    expect([store.get('image3.x'), store.get('image3.visible')]).toEqual([-0.4, false]);
    expect(store.getMod('image3.scale')).toEqual({ source: 'snare', amount: 0.5 });
    expect([store.get('image2.blend'), store.get('image2.x'), store.get('image2.visible')]).toEqual(['screen', -0.62, true]);
    expect(store.getMod('image2.scale')).toEqual({ source: 'kick', amount: 0.02 });

    store.copyGroup('image3', 'image9');
    expect([store.get('image9.x'), store.get('image9.visible')]).toEqual([-0.4, false]);
    expect(store.getMod('image9.scale')).toEqual({ source: 'snare', amount: 0.5 });
    // A copy, not a link.
    store.set('image3.x', 0.1);
    expect(store.get('image9.x')).toBe(-0.4);
  });

  it('keep their settings through presets that do not store them, and through Random', () => {
    const store = createParamStore();
    store.set('image2.x', -0.5);
    store.load({ version: 1, values: { 'image.scale': 0.4 } });
    expect(store.get('image.scale')).toBe(0.4);
    expect(store.get('image2.x')).toBe(-0.5);
    randomizeLook(store, createRng(3));
    expect(store.get('image.scale')).toBe(0.4);
    expect(store.get('image2.x')).toBe(-0.5);
  });
});

describe('Output size', () => {
  it('reads a listed resolution, or the custom size made even', () => {
    const store = createParamStore();
    expect(outputSize(store)).toEqual({ width: 1920, height: 1080 });
    store.set('system.resolution', '1080x1080');
    expect(outputSize(store)).toEqual({ width: 1080, height: 1080 });
    store.set('system.resolution', 'custom');
    store.set('system.width', 1081);
    store.set('system.height', 607);
    expect(outputSize(store)).toEqual({ width: 1082, height: 608 });
  });

  it('lists only sizes that parse back to themselves and suit video encoders', () => {
    for (const { value } of RESOLUTIONS) {
      const { width, height } = parseResolution(value);
      expect(`${width}x${height}`).toBe(value);
      expect(width % 2 + height % 2).toBe(0);
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
