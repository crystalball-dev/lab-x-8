import { describe, expect, it } from 'vitest';
import { LookCycler, cycleStep, lookIndex } from '../src/app/LookCycler';
import { createFeatures } from '../src/audio/analysis/features';
import { createModSources } from '../src/params/modulation';
import { PresetManager } from '../src/params/presets';
import { createParamStore } from '../src/params/schema';

describe('cycleStep', () => {
  it('fades into the next segment during the last bars of each one', () => {
    expect(cycleStep(0, 16, 2)).toEqual({ segment: 0, progress: null });
    expect(cycleStep(13.9, 16, 2)).toEqual({ segment: 0, progress: null });
    expect(cycleStep(14, 16, 2)).toEqual({ segment: 0, progress: 0 });
    expect(cycleStep(15, 16, 2)).toEqual({ segment: 0, progress: 0.5 });
    expect(cycleStep(16, 16, 2)).toEqual({ segment: 1, progress: null });
  });

  it('cuts on the bar line without a fade, and fades for a whole segment at most', () => {
    expect(cycleStep(15.99, 16, 0).progress).toBeNull();
    expect(cycleStep(16, 16, 0).segment).toBe(1);
    expect(cycleStep(2, 4, 8)).toEqual({ segment: 0, progress: 0.5 });
  });

  it('counts segments before the first bar line too', () => {
    expect(cycleStep(-1, 16, 2)).toEqual({ segment: -1, progress: 0.5 });
  });
});

describe('lookIndex', () => {
  it('plays the pool in order and wraps around', () => {
    expect([0, 1, 2, 3, 4].map((k) => lookIndex(k, 3, 'sequential', 0))).toEqual([0, 1, 2, 0, 1]);
    expect(lookIndex(-1, 3, 'sequential', 0)).toBe(2);
  });

  it('shuffles every look once per pass, the same way for the same seed', () => {
    const pass = (seed: number, n: number): number[] =>
      Array.from({ length: 7 }, (_, i) => lookIndex(n * 7 + i, 7, 'random', seed));
    for (let n = 0; n < 20; n++) expect([...pass(5, n)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pass(5, 3)).toEqual(pass(5, 3));
    expect(pass(5, 0)).not.toEqual(pass(6, 0));
  });

  it('never shows the same look twice in a row', () => {
    for (const size of [2, 3, 4, 7]) {
      for (let k = -20; k < 400; k++) {
        expect(lookIndex(k, size, 'random', 42)).not.toBe(lookIndex(k + 1, size, 'random', 42));
      }
    }
  });
});

/** A cycler over the built-in looks, or random looks: every 4 bars, with a fade of 1 bar. */
function setup(pool = 'builtin', before: (params: ReturnType<typeof createParamStore>) => void = () => {}) {
  const params = createParamStore();
  const presets = new PresetManager(params);
  before(params);
  params.set('cycle.on', true);
  params.set('cycle.pool', pool);
  params.set('cycle.bars', '4');
  params.set('cycle.fade', 1);
  const shown: string[] = [];
  const cycler = new LookCycler(params, presets, (preset) => shown.push(preset?.name ?? 'random'));
  const looks = presets.all.filter((p) => p.builtIn);
  const features = createFeatures();
  const sources = createModSources();
  /** Moves the music to `bar` (4 beats per bar) and runs one frame of the cycle. */
  const at = (bar: number) => {
    features.beatCount = Math.floor(bar * 4);
    features.beatPhase = bar * 4 - features.beatCount;
    return cycler.update(features, sources);
  };
  const generator = (index: number) => looks[index]!.data.values['layers.a'];
  return { params, cycler, shown, looks, at, generator };
}

describe('LookCycler', () => {
  it('shows the scheduled look and fades into the next one before the bar line', () => {
    const { params, shown, looks, at, generator } = setup();
    expect(at(0)).toBeNull();
    expect(shown).toEqual([looks[0]!.name]);
    expect(params.str('layers.a')).toBe(generator(0));

    for (let bar = 0.1; bar < 3; bar += 0.1) expect(at(bar)).toBeNull();
    const fade = at(3.5)!;
    expect(fade.progress).toBeCloseTo(0.5);
    // The new look is in the parameters, the old one fades out from its own copy.
    expect(params.str('layers.a')).toBe(generator(1));
    expect(fade.from.str('layers.a')).toBe(generator(0));

    expect(at(4.05)).toBeNull();
    expect(shown).toEqual([looks[0]!.name, looks[1]!.name]);
  });

  it('picks up the right looks after a jump, as at the start of an export', () => {
    const { params, at, generator } = setup();
    at(0);
    const fade = at(7.5)!;
    expect(fade.progress).toBeCloseTo(0.5);
    expect(fade.from.str('layers.a')).toBe(generator(1));
    expect(params.str('layers.a')).toBe(generator(2));
  });

  it('reaches the same look by playing through as by jumping there', () => {
    const played = setup();
    for (let bar = 0; bar < 21; bar += 0.25) played.at(bar);
    const jumped = setup();
    jumped.at(21);
    expect(jumped.params.snapshot()).toEqual(played.params.snapshot());
  });

  it('starts a new transition with a new id', () => {
    const { at } = setup();
    at(0);
    const first = at(3.2)!.id;
    expect(at(3.4)!.id).toBe(first);
    at(4.5);
    expect(at(7.2)!.id).not.toBe(first);
  });

  it('does nothing while switched off', () => {
    const { params, shown, at } = setup();
    params.set('cycle.on', false);
    const before = params.snapshot();
    expect(at(3.5)).toBeNull();
    expect(shown).toEqual([]);
    expect(params.snapshot()).toEqual(before);
  });
});

describe('LookCycler with random looks', () => {
  /** Everything Random may change, and the settings it must leave alone. */
  const look = (params: ReturnType<typeof createParamStore>) => {
    const values = params.snapshot().values;
    return Object.fromEntries(Object.entries(values).filter(([path]) => !path.startsWith('image.') && !path.startsWith('output.')));
  };
  const mine = (params: ReturnType<typeof createParamStore>) => {
    params.set('image.scale', 0.5);
    params.set('output.gain', 1.3);
    params.set('color.exposure', 1.7);
  };

  it('rolls the same look for the same bar, and a new one for the next segment', () => {
    const a = setup('random');
    a.at(0);
    const first = look(a.params);
    const b = setup('random');
    b.at(0);
    expect(look(b.params)).toEqual(first);
    a.at(4.5);
    expect(look(a.params)).not.toEqual(first);
    expect(a.shown).toEqual(['random', 'random']);
  });

  it('reaches the same random look by playing through as by jumping there', () => {
    const played = setup('random', mine);
    for (let bar = 0; bar < 13; bar += 0.25) played.at(bar);
    const jumped = setup('random', mine);
    jumped.at(13);
    expect(jumped.params.snapshot()).toEqual(played.params.snapshot());
  });

  it('leaves alone what the Random button leaves alone', () => {
    const { params, at } = setup('random', mine);
    at(0);
    at(5);
    expect(params.get('image.scale')).toBe(0.5);
    expect(params.get('output.gain')).toBe(1.3);
    expect(params.get('color.exposure')).toBe(1.7);
  });

  it('rolls a different series for another shuffle number', () => {
    const a = setup('random');
    a.at(0);
    const b = setup('random', (params) => params.set('cycle.seed', 7));
    b.at(0);
    expect(look(b.params)).not.toEqual(look(a.params));
  });

  it('fades from one random look into the next', () => {
    const { params, at } = setup('random');
    at(0);
    const first = look(params);
    const fade = at(3.5)!;
    expect(fade.progress).toBeCloseTo(0.5);
    expect(look(fade.from)).toEqual(first);
    expect(look(params)).not.toEqual(first);
  });
});
