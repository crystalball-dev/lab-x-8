import { BANDS, DEFAULT_BPM, TEMPO_MAX_BPM, TEMPO_MIN_BPM } from '../audio/analysis/features';
import { GENERATORS } from '../effects/generators';
import { STAGES } from '../effects/stages';
import type { EffectDef } from '../effects/types';
import { ParamStore } from './ParamStore';
import type { ParamDef, ParamGroup } from './types';

/** Input and analysis settings. They describe the venue, so presets leave them alone. */
export const AUDIO_GROUP: ParamGroup = {
  id: 'audio',
  label: 'Audio',
  preset: false,
  params: [
    { key: 'gain', label: 'Input gain', type: 'float', min: 0, max: 8, step: 0.01, default: 1, rand: false },
    { key: 'reactivity', label: 'Reactivity', type: 'float', min: 0, max: 3, step: 0.01, default: 1, rand: false, hint: 'Master multiplier for everything the audio drives' },
    { key: 'smoothing', label: 'Smoothing', type: 'float', min: 0, max: 1, step: 0.01, default: 0.35, rand: false },
    { key: 'onsets', label: 'Onset sensitivity', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5, rand: false },
    { key: 'agc', label: 'Auto gain', type: 'bool', default: true, hint: 'Normalizes against the recent peak so quiet and loud sources both work' },
    { key: 'volume', label: 'Playback volume', type: 'float', min: 0, max: 1, step: 0.01, default: 0.8, rand: false },
    ...BANDS.map(
      (band): ParamDef => ({
        key: band.id,
        label: `${band.label} sensitivity`,
        type: 'float',
        min: 0,
        max: 3,
        step: 0.01,
        default: 1,
        rand: false,
        hint: `${band.lo} to ${band.hi} Hz`,
      }),
    ),
  ],
};

/**
 * The beat grid. The tempo is chosen, not detected: it belongs to the music being played,
 * so presets leave it alone.
 */
export const TEMPO_GROUP: ParamGroup = {
  id: 'tempo',
  label: 'Tempo',
  preset: false,
  params: [
    { key: 'bpm', label: 'BPM', type: 'float', min: TEMPO_MIN_BPM, max: TEMPO_MAX_BPM, step: 0.01, default: DEFAULT_BPM, rand: false, hint: 'Tempo of the music. Drives the beat and bar clocks and the demo loop.' },
    { key: 'offset', label: 'Beat offset', type: 'float', min: -8, max: 8, step: 0.01, default: 0, rand: false, hint: 'Moves the beat grid, in beats. Tap tempo sets it for you.' },
    { key: 'beatsPerBar', label: 'Beats per bar', type: 'int', min: 1, max: 8, default: 4, rand: false },
  ],
};

/** How one look gives way to the next. The order matches the styles in transition.frag. */
export const TRANSITION_STYLES = [
  { value: 'fade', label: 'Crossfade' },
  { value: 'screen', label: 'Screen' },
  { value: 'light', label: 'Brightest first' },
  { value: 'glitch', label: 'Glitch blocks' },
];

/**
 * Changing looks automatically during a track. A way of playing the presets, not part of one,
 * so presets leave it alone.
 */
export const CYCLE_GROUP: ParamGroup = {
  id: 'cycle',
  label: 'Cycle',
  preset: false,
  params: [
    { key: 'on', label: 'Cycle looks', type: 'bool', default: false },
    {
      key: 'pool',
      label: 'Looks',
      type: 'select',
      default: 'all',
      options: [
        { value: 'all', label: 'All presets' },
        { value: 'builtin', label: 'Built-in looks' },
        { value: 'user', label: 'Your presets' },
        { value: 'random', label: 'Random looks' },
      ],
    },
    {
      key: 'order',
      label: 'Order',
      type: 'select',
      default: 'sequential',
      options: [
        { value: 'sequential', label: 'In order' },
        { value: 'random', label: 'Shuffled' },
      ],
    },
    {
      key: 'bars',
      label: 'Every',
      type: 'select',
      default: '16',
      options: [4, 8, 16, 32, 64].map((n) => ({ value: String(n), label: `${n} bars` })),
    },
    { key: 'fade', label: 'Transition', type: 'float', min: 0, max: 8, step: 0.25, default: 2, rand: false, hint: 'Length in bars, ending on the bar line. 0 cuts on the bar line.' },
    { key: 'style', label: 'Style', type: 'select', default: 'fade', options: TRANSITION_STYLES },
    { key: 'seed', label: 'Shuffle', type: 'int', min: 0, max: 9999, default: 1, rand: false, hint: 'The same number deals the same order, or rolls the same random looks, again' },
  ],
};

/** Groups of the look that Random leaves alone: the picture and the output settings. */
const RANDOMIZE_SKIP = new Set(['image', 'output']);

/**
 * Rolls a new look, as the Random button does. Settings without a random range, such as the
 * exposure or the custom colours, stay as they are.
 */
export function randomizeLook(store: ParamStore, rng: () => number): void {
  store.randomize(rng, (_path, group) => !RANDOMIZE_SKIP.has(group.id));
}

/** Global motion controls shared by every generator. */
export const MOTION_GROUP: ParamGroup = {
  id: 'motion',
  label: 'Motion',
  params: [
    { key: 'speed', label: 'Speed', type: 'float', min: 0, max: 3, step: 0.01, default: 1, rand: [0.6, 1.4] },
    { key: 'surge', label: 'Energy surge', type: 'float', min: 0, max: 4, step: 0.01, default: 1.2, rand: [0.5, 2.5], hint: 'How much loud passages speed up the motion' },
  ],
};

/** Listed output sizes: wide 16:9 first, then square, upright and other shapes. */
export const RESOLUTIONS = [
  { value: '1280x720', label: '720p  (1280 x 720)' },
  { value: '1920x1080', label: '1080p (1920 x 1080)' },
  { value: '2560x1440', label: '1440p (2560 x 1440)' },
  { value: '3840x2160', label: '2160p (3840 x 2160)' },
  { value: '1080x1080', label: 'Square 1:1 (1080 x 1080)' },
  { value: '1440x1440', label: 'Square 1:1 (1440 x 1440)' },
  { value: '2160x2160', label: 'Square 1:1 (2160 x 2160)' },
  { value: '1080x1350', label: 'Portrait 4:5 (1080 x 1350)' },
  { value: '1080x1920', label: 'Vertical 9:16 (1080 x 1920)' },
  { value: '1440x2560', label: 'Vertical 9:16 (1440 x 2560)' },
  { value: '1440x1080', label: 'Classic 4:3 (1440 x 1080)' },
  { value: '2560x1080', label: 'Ultrawide 21:9 (2560 x 1080)' },
];

/** The resolution setting that uses the custom width and height. */
export const CUSTOM_RESOLUTION = 'custom';

/** Machine settings. Never part of a preset. */
export const SYSTEM_GROUP: ParamGroup = {
  id: 'system',
  label: 'Display',
  preset: false,
  params: [
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      default: '1920x1080',
      options: [...RESOLUTIONS, { value: CUSTOM_RESOLUTION, label: 'Custom size' }],
    },
    { key: 'width', label: 'Width', type: 'int', min: 16, max: 7680, default: 1920, rand: false, hint: 'Custom width in pixels. An odd number is rounded up, because video encoders need even sizes.' },
    { key: 'height', label: 'Height', type: 'int', min: 16, max: 7680, default: 1080, rand: false, hint: 'Custom height in pixels. An odd number is rounded up, because video encoders need even sizes.' },
    { key: 'renderScale', label: 'Render scale', type: 'float', min: 0.5, max: 1, step: 0.05, default: 1, rand: false, hint: 'Lower values render the scene smaller and upscale it. CRT detail stays sharp.' },
    {
      key: 'fpsLimit',
      label: 'Frame rate',
      type: 'select',
      default: 'display',
      options: [
        { value: 'display', label: 'Match display' },
        { value: '120', label: '120 fps' },
        { value: '60', label: '60 fps' },
        { value: '30', label: '30 fps' },
      ],
    },
    { key: 'hud', label: 'Show stats', type: 'bool', default: true },
  ],
};

function effectGroup(def: EffectDef): ParamGroup {
  return { id: def.id, label: def.label, params: def.params };
}

/** Builds the parameter store with every group the app knows about. */
export function createParamStore(): ParamStore {
  const store = new ParamStore();
  store.register(TEMPO_GROUP);
  store.register(CYCLE_GROUP);
  store.register(AUDIO_GROUP);
  store.register(effectGroup(STAGES.layers));
  for (const generator of GENERATORS) store.register(effectGroup(generator));
  store.register(MOTION_GROUP);
  // Presets without image settings, such as the built-in looks, leave the picture where it was put.
  store.register({ ...effectGroup(STAGES.image), optional: true });
  store.register(effectGroup(STAGES.feedback));
  store.register(effectGroup(STAGES.color));
  store.register(effectGroup(STAGES.glitch));
  store.register(effectGroup(STAGES.bloom));
  store.register(effectGroup(STAGES.crt));
  store.register(effectGroup(STAGES.output));
  store.register(SYSTEM_GROUP);
  return store;
}

export function parseResolution(value: string): { width: number; height: number } {
  const [w, h] = value.split('x').map(Number);
  return { width: w || 1920, height: h || 1080 };
}

/** The output size in pixels: a listed resolution, or the custom width and height made even. */
export function outputSize(params: ParamStore): { width: number; height: number } {
  const value = params.str('system.resolution');
  if (value !== CUSTOM_RESOLUTION) return parseResolution(value);
  const even = (n: number): number => Math.ceil(n / 2) * 2;
  return { width: even(params.num('system.width')), height: even(params.num('system.height')) };
}
