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

/** Global motion controls shared by every generator. */
export const MOTION_GROUP: ParamGroup = {
  id: 'motion',
  label: 'Motion',
  params: [
    { key: 'speed', label: 'Speed', type: 'float', min: 0, max: 3, step: 0.01, default: 1, rand: [0.6, 1.4] },
    { key: 'surge', label: 'Energy surge', type: 'float', min: 0, max: 4, step: 0.01, default: 1.2, rand: [0.5, 2.5], hint: 'How much loud passages speed up the motion' },
  ],
};

export const RESOLUTIONS = [
  { value: '1280x720', label: '720p  (1280 x 720)' },
  { value: '1920x1080', label: '1080p (1920 x 1080)' },
  { value: '2560x1440', label: '1440p (2560 x 1440)' },
  { value: '3840x2160', label: '2160p (3840 x 2160)' },
];

/** Machine settings. Never part of a preset. */
export const SYSTEM_GROUP: ParamGroup = {
  id: 'system',
  label: 'Display',
  preset: false,
  params: [
    { key: 'resolution', label: 'Resolution', type: 'select', default: '1920x1080', options: RESOLUTIONS },
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
  store.register(AUDIO_GROUP);
  store.register(effectGroup(STAGES.layers));
  for (const generator of GENERATORS) store.register(effectGroup(generator));
  store.register(MOTION_GROUP);
  store.register(effectGroup(STAGES.image));
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
