import type { AudioFeatures } from '../audio/analysis/features';
import type { Transition } from '../gfx/Renderer';
import type { ParamStore } from '../params/ParamStore';
import { upgradePreset, type Preset, type PresetManager } from '../params/presets';
import { createParamStore, randomizeLook } from '../params/schema';
import { createRng } from '../util/math';

export type CycleOrder = 'sequential' | 'random';

/** Where the cycle stands at one position in the music. */
export interface CycleStep {
  /** The segment playing, counted from the start of the track. */
  segment: number;
  /** How far the transition into the next segment has got, 0 to 1, or null outside one. */
  progress: number | null;
}

/**
 * Where the cycle stands `bar` bars into the track. Segment k fills the bars from k * every to
 * (k + 1) * every, and the transition into the next one takes its last `fade` bars, so the new
 * look has fully arrived on the bar line.
 */
export function cycleStep(bar: number, every: number, fade: number): CycleStep {
  const segment = Math.floor(bar / every);
  const length = Math.min(Math.max(fade, 0), every);
  const start = (segment + 1) * every - length;
  if (length > 0 && bar >= start) return { segment, progress: (bar - start) / length };
  return { segment, progress: null };
}

/**
 * Which look of a pool of `size` plays in a segment: in order, or shuffled again for every pass
 * through the pool, never showing the same look twice in a row across two passes.
 */
export function lookIndex(segment: number, size: number, order: CycleOrder, seed: number): number {
  const position = ((segment % size) + size) % size;
  // With two looks, any order without repeats is plain alternation.
  if (order === 'sequential' || size <= 2) return position;
  const pass = Math.floor(segment / size);
  const deal = shuffle(size, seed, pass);
  if (deal[0] === shuffle(size, seed, pass - 1)[size - 1]) [deal[0], deal[1]] = [deal[1]!, deal[0]!];
  return deal[position]!;
}

/** Random numbers for one segment or pass of the cycle, the same again for the same seed. */
function rngFor(seed: number, index: number, salt = 0): () => number {
  return createRng((Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index, 0x85ebca6b) ^ salt) >>> 0);
}

/** Salt for the random looks, so they are not tied to the shuffled order of the same seed. */
const ROLL = 0x27d4eb2f;

function shuffle(size: number, seed: number, pass: number): number[] {
  const rng = rngFor(seed, pass);
  const deal = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deal[i], deal[j]] = [deal[j]!, deal[i]!];
  }
  return deal;
}

/**
 * Plays the presets one after another, or rolls random looks, changing on bar lines.
 *
 * The cycle is a function of the position in the music: a given segment of a track always shows
 * the same look. A random look is rolled the way the Random button rolls one, from a seed made
 * of the shuffle number and the segment, so it too comes out the same every time. During playback a transition starts as the position enters it, from whatever is
 * on screen. After a jump, such as a seek or the start of an export, the cycle picks up wherever
 * the position is. That is what makes an export change looks at the same moments as the preview.
 */
export class LookCycler {
  /** The look fading out, kept apart so it carries on reacting to the music while it goes. */
  private readonly fading: ParamStore = createParamStore();
  private lastBar = Number.NaN;
  /** The segment whose look is loaded, or is fading in. */
  private shown = Number.NaN;
  private transition: Transition | null = null;
  private transitions = 0;
  private cached: { key: string; pool: Preset[] } | null = null;

  constructor(
    private readonly params: ParamStore,
    private readonly presets: PresetManager,
    /** Told about every look the cycle puts on screen: its preset, or null for a random look. */
    private readonly onLook: (preset: Preset | null) => void,
  ) {}

  /** Forgets the position, so the next update chooses the looks afresh. */
  reset(): void {
    this.lastBar = Number.NaN;
    this.shown = Number.NaN;
    this.transition = null;
  }

  /**
   * Call once per frame, after the clock has worked out the modulation sources.
   * @returns the transition to draw, or null while one look fills the screen
   */
  update(audio: AudioFeatures, sources: Float32Array): Transition | null {
    const p = this.params;
    const pool = this.pool();
    if (!p.bool('cycle.on') || (!this.random && pool.length < 2)) {
      this.reset();
      return null;
    }

    const bar = this.bar(audio);
    const step = cycleStep(bar, Number(p.str('cycle.bars')), p.num('cycle.fade'));
    const target = step.progress === null ? step.segment : step.segment + 1;
    const jumped = !(bar >= this.lastBar && bar - this.lastBar < 1);
    this.lastBar = bar;

    let loaded = false;
    if (jumped || target !== this.shown) {
      if (step.progress === null) {
        this.transition = null;
      } else {
        // The look fading out is what is on screen, or after a jump, the look scheduled there.
        this.fading.load(p.snapshot({ includeSystem: true }), { includeSystem: true });
        if (jumped) this.show(this.fading, pool, step.segment);
        this.transition = { id: ++this.transitions, from: this.fading, progress: 0, style: 0 };
      }
      this.onLook(this.show(p, pool, target));
      this.shown = target;
      loaded = true;
    } else if (step.progress === null) {
      this.transition = null;
    }

    if (loaded) p.applyModulation(sources);
    if (this.transition) {
      this.transition.progress = step.progress ?? 1;
      this.transition.style = p.num('cycle.style');
      this.fading.applyModulation(sources);
    }
    return this.transition;
  }

  /** One line about the cycle for the control panel. */
  describe(): string {
    const p = this.params;
    if (!p.bool('cycle.on')) return 'Off. Turn it on to change looks during the track.';
    const pool = this.pool();
    if (!this.random && pool.length < 2) {
      return p.str('cycle.pool') === 'user'
        ? 'Save at least two presets of your own to cycle through them.'
        : 'Needs at least two looks.';
    }
    if (Number.isNaN(this.lastBar)) return 'Starts with the music.';
    const every = Number(p.str('cycle.bars'));
    const fade = Math.min(Math.max(p.num('cycle.fade'), 0), every);
    const step = cycleStep(this.lastBar, every, fade);
    const bars = Math.max(1, Math.ceil((step.segment + 1) * every - fade - this.lastBar));
    const inBars = `in ${bars} bar${bars === 1 ? '' : 's'}`;
    if (this.random) {
      return step.progress === null ? `A random look. The next one ${inBars}.` : 'Changing to a new random look.';
    }
    const next = this.look(pool, step.segment + 1).name;
    if (step.progress !== null) return `Changing to ${next}`;
    return `${this.look(pool, step.segment).name}. ${next} ${inBars}.`;
  }

  private get random(): boolean {
    return this.params.str('cycle.pool') === 'random';
  }

  /** Puts the look of a segment into `store`. Returns its preset, or null for a random look. */
  private show(store: ParamStore, pool: Preset[], segment: number): Preset | null {
    if (this.random) {
      randomizeLook(store, rngFor(this.params.num('cycle.seed'), segment, ROLL));
      return null;
    }
    const preset = this.look(pool, segment);
    store.load(upgradePreset(preset.data));
    return preset;
  }

  /** Position in bars from the start of the track, from the beat clock. */
  private bar(audio: AudioFeatures): number {
    const perBar = Math.max(1, Math.round(this.params.num('tempo.beatsPerBar')));
    return (audio.beatCount + audio.beatPhase) / perBar;
  }

  private look(pool: Preset[], segment: number): Preset {
    const p = this.params;
    const order = p.str('cycle.order') as CycleOrder;
    return pool[lookIndex(segment, pool.length, order, p.num('cycle.seed'))]!;
  }

  /** The presets taking part, in the order of the preset list. None for random looks. */
  private pool(): Preset[] {
    const choice = this.params.str('cycle.pool');
    const key = `${choice}:${this.presets.version}`;
    if (this.cached?.key !== key) {
      const all = this.presets.all;
      const pool =
        choice === 'random'
          ? []
          : choice === 'builtin'
            ? all.filter((p) => p.builtIn)
            : choice === 'user'
              ? all.filter((p) => !p.builtIn)
              : all;
      this.cached = { key, pool };
    }
    return this.cached.pool;
  }
}
