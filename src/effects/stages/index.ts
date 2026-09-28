import { PALETTE_OPTIONS } from '../../params/palettes';
import { GENERATOR_OPTIONS } from '../generators';
import { publishShaders, sameParams, toHotShaders } from '../hot';
import type { EffectDef } from '../types';
import bloomCombine from './bloom_combine.frag?raw';
import bloomDown from './bloom_down.frag?raw';
import bloomUp from './bloom_up.frag?raw';
import color from './color.frag?raw';
import crt from './crt.frag?raw';
import feedback from './feedback.frag?raw';
import glitch from './glitch.frag?raw';
import image from './image.frag?raw';
import layers from './layers.frag?raw';
import output from './output.frag?raw';

const BLEND_OPTIONS = [
  { value: 'mix', label: 'Crossfade' },
  { value: 'add', label: 'Add' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'difference', label: 'Difference' },
  { value: 'brighter', label: 'Brighter wins' },
];

/**
 * The fixed stages of the pipeline, in the order they run.
 * Each stage owns one parameter group and one shader (bloom owns three).
 */
export const STAGES = {
  layers: {
    id: 'layers',
    label: 'Layers',
    description: 'Two pattern generators and how they blend',
    fragment: layers,
    params: [
      { key: 'a', label: 'Layer A', type: 'select', default: 'tunnel', options: GENERATOR_OPTIONS, rand: true },
      {
        key: 'b',
        label: 'Layer B',
        type: 'select',
        default: 'kaleido',
        options: [{ value: 'none', label: 'None' }, ...GENERATOR_OPTIONS],
        rand: true,
      },
      { key: 'mix', label: 'B amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.6, rand: [0.3, 1] },
      { key: 'blend', label: 'Blend', type: 'select', default: 'brighter', options: BLEND_OPTIONS, rand: true },
    ],
  },

  image: {
    id: 'image',
    label: 'Image',
    description: 'Your picture as a layer that the audio bends',
    fragment: image,
    params: [
      { key: 'opacity', label: 'Opacity', type: 'float', min: 0, max: 1, step: 0.01, default: 0.85, rand: false },
      {
        key: 'blend',
        label: 'Blend',
        type: 'select',
        default: 'under',
        options: [
          { value: 'under', label: 'Base layer' },
          { value: 'over', label: 'Over' },
          { value: 'add', label: 'Add' },
          { value: 'screen', label: 'Screen' },
          { value: 'multiply', label: 'Multiply' },
          { value: 'difference', label: 'Difference' },
          { value: 'mask', label: 'Mask' },
        ],
      },
      {
        key: 'fit',
        label: 'Fit',
        type: 'select',
        default: 'cover',
        options: [
          { value: 'cover', label: 'Cover' },
          { value: 'contain', label: 'Contain' },
          { value: 'stretch', label: 'Stretch' },
          { value: 'tile', label: 'Tile' },
        ],
      },
      { key: 'scale', label: 'Scale', type: 'float', min: 0.25, max: 4, step: 0.01, default: 1, mod: { source: 'kick', amount: 0.02 }, rand: false },
      { key: 'brightness', label: 'Brightness', type: 'float', min: 0, max: 3, step: 0.01, default: 1, rand: false },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, default: 0.15, mod: { source: 'bass', amount: 0.3 }, rand: [0, 0.5] },
      { key: 'ripple', label: 'Ripple', type: 'float', min: 0, max: 1, step: 0.01, default: 0.3, rand: [0, 0.7] },
      { key: 'split', label: 'RGB split', type: 'float', min: 0, max: 0.05, step: 0.0005, default: 0.002, mod: { source: 'kick', amount: 0.3 }, rand: [0, 0.01] },
      { key: 'displace', label: 'Pattern displace', type: 'float', min: 0, max: 1, step: 0.01, default: 0.2, rand: [0, 0.6] },
      { key: 'rotate', label: 'Rotate', type: 'float', min: -2, max: 2, step: 0.01, default: 0, rand: false },
      { key: 'kaleido', label: 'Mirrors', type: 'int', min: 0, max: 12, default: 0, rand: false, hint: '0 turns the kaleidoscope off' },
    ],
  },

  feedback: {
    id: 'feedback',
    label: 'Feedback',
    description: 'Video feedback: trails, tunnels of echoes, analog persistence',
    fragment: feedback,
    params: [
      { key: 'amount', label: 'Persistence', type: 'float', min: 0, max: 0.995, step: 0.001, default: 0.8, rand: [0.6, 0.93] },
      { key: 'zoom', label: 'Zoom', type: 'float', min: -0.1, max: 0.1, step: 0.0005, default: 0.02, mod: { source: 'bass', amount: 0.1 }, rand: [-0.02, 0.04] },
      { key: 'rotate', label: 'Rotate', type: 'float', min: -0.1, max: 0.1, step: 0.0005, default: 0.002, rand: [-0.015, 0.015] },
      { key: 'shiftX', label: 'Shift X', type: 'float', min: -0.05, max: 0.05, step: 0.0005, default: 0, rand: false },
      { key: 'shiftY', label: 'Shift Y', type: 'float', min: -0.05, max: 0.05, step: 0.0005, default: 0, rand: false },
      { key: 'warp', label: 'Melt', type: 'float', min: 0, max: 1, step: 0.01, default: 0.2, rand: [0, 0.6] },
      { key: 'hue', label: 'Hue drift', type: 'float', min: -0.2, max: 0.2, step: 0.001, default: 0.008, rand: [-0.03, 0.03] },
      { key: 'blur', label: 'Soften', type: 'float', min: 0, max: 1, step: 0.01, default: 0.25, rand: [0, 0.6] },
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'trails',
        options: [
          { value: 'trails', label: 'Trails' },
          { value: 'add', label: 'Build-up' },
          { value: 'screen', label: 'Screen' },
          { value: 'ghost', label: 'Ghosting' },
        ],
      },
      {
        key: 'tap',
        label: 'Loop source',
        type: 'select',
        default: 'scene',
        hint: 'Which point of the pipeline is fed back. Later taps also recirculate glitches or glow.',
        options: [
          { value: 'scene', label: 'Scene' },
          { value: 'glitch', label: 'After glitch' },
          { value: 'final', label: 'After bloom (burns in)' },
        ],
      },
    ],
  },

  color: {
    id: 'color',
    label: 'Colour',
    description: 'Palette and grading',
    fragment: color,
    params: [
      { key: 'palette', label: 'Palette', type: 'select', default: 'neon', options: PALETTE_OPTIONS, rand: true },
      { key: 'custom1', label: 'Custom 1', type: 'color', default: '#ff0080' },
      { key: 'custom2', label: 'Custom 2', type: 'color', default: '#7a00ff' },
      { key: 'custom3', label: 'Custom 3', type: 'color', default: '#00e5ff' },
      { key: 'custom4', label: 'Custom 4', type: 'color', default: '#ffee00' },
      { key: 'exposure', label: 'Exposure', type: 'float', min: 0, max: 4, step: 0.01, default: 1, rand: false },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.5, max: 2, step: 0.01, default: 1.1, rand: [0.95, 1.3] },
      { key: 'saturation', label: 'Saturation', type: 'float', min: 0, max: 2.5, step: 0.01, default: 1.25, rand: [1, 1.6] },
      { key: 'hue', label: 'Hue shift', type: 'float', min: 0, max: 1, step: 0.001, default: 0, rand: false },
      { key: 'paletteMap', label: 'Palette remap', type: 'float', min: 0, max: 1, step: 0.01, default: 0, rand: false, hint: 'Re-colours the picture by brightness through the palette' },
      { key: 'posterize', label: 'Posterize', type: 'float', min: 0, max: 1, step: 0.01, default: 0, rand: false },
      { key: 'invert', label: 'Invert', type: 'float', min: 0, max: 1, step: 0.01, default: 0, rand: false },
    ],
  },

  glitch: {
    id: 'glitch',
    label: 'Glitch',
    description: 'Digital corruption that fires with the transients',
    fragment: glitch,
    params: [
      { key: 'amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.12, mod: { source: 'onset', amount: 0.4 }, rand: [0, 0.3] },
      { key: 'rate', label: 'Rate', type: 'float', min: 1, max: 30, step: 0.1, default: 12, rand: [6, 20], hint: 'How many times per second the corruption re-rolls' },
      { key: 'slices', label: 'Slices', type: 'float', min: 0, max: 1, step: 0.01, default: 0.7, rand: [0.2, 1] },
      { key: 'blocks', label: 'Blocks', type: 'float', min: 0, max: 1, step: 0.01, default: 0.4, rand: [0, 0.8] },
      { key: 'shift', label: 'Shift', type: 'float', min: 0, max: 0.4, step: 0.001, default: 0.12, rand: [0.04, 0.25] },
      { key: 'rgb', label: 'RGB split', type: 'float', min: 0, max: 0.05, step: 0.0005, default: 0.003, mod: { source: 'kick', amount: 0.25 }, rand: [0, 0.01] },
      { key: 'tear', label: 'Tear', type: 'float', min: 0, max: 1, step: 0.01, default: 0.3, rand: [0, 0.7] },
      { key: 'mosaic', label: 'Mosaic', type: 'float', min: 0, max: 1, step: 0.01, default: 0.15, rand: [0, 0.5] },
      { key: 'crush', label: 'Bit crush', type: 'float', min: 0, max: 1, step: 0.01, default: 0, rand: [0, 0.4] },
      { key: 'streaks', label: 'Dropouts', type: 'float', min: 0, max: 1, step: 0.01, default: 0.4, rand: [0, 0.8] },
    ],
  },

  bloom: {
    id: 'bloom',
    label: 'Bloom',
    description: 'Glow around bright areas',
    fragment: bloomCombine,
    params: [
      { key: 'intensity', label: 'Intensity', type: 'float', min: 0, max: 2, step: 0.01, default: 0.55, mod: { source: 'level', amount: 0.12 }, rand: [0.3, 0.9] },
      { key: 'threshold', label: 'Threshold', type: 'float', min: 0, max: 2, step: 0.01, default: 0.55, rand: [0.35, 0.8] },
      { key: 'radius', label: 'Radius', type: 'float', min: 0.2, max: 0.95, step: 0.01, default: 0.7, rand: [0.55, 0.85] },
    ],
  },

  crt: {
    id: 'crt',
    label: 'CRT',
    description: 'Analog monitor: sync errors, colour bleed, scanlines, phosphor mask, tube',
    fragment: crt,
    params: [
      { key: 'amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.85, rand: [0.5, 1], hint: 'Master strength. 0 bypasses the stage.' },
      { key: 'curvature', label: 'Curvature', type: 'float', min: 0, max: 1, step: 0.01, default: 0.3, rand: [0, 0.6] },
      { key: 'scanlines', label: 'Scanlines', type: 'float', min: 0, max: 1, step: 0.01, default: 0.55, rand: [0.3, 0.8] },
      { key: 'pitch', label: 'Line pitch', type: 'int', min: 2, max: 12, default: 4, rand: [3, 6], hint: 'Height of one scanline in output pixels' },
      { key: 'interlace', label: 'Interlace', type: 'bool', default: false },
      { key: 'mask', label: 'Phosphor mask', type: 'float', min: 0, max: 1, step: 0.01, default: 0.35, rand: [0.1, 0.6] },
      {
        key: 'maskType',
        label: 'Mask type',
        type: 'select',
        default: 'grille',
        rand: true,
        options: [
          { value: 'grille', label: 'Aperture grille' },
          { value: 'shadow', label: 'Shadow mask' },
          { value: 'slot', label: 'Slot mask' },
        ],
      },
      { key: 'bleed', label: 'Colour bleed', type: 'float', min: 0, max: 1, step: 0.01, default: 0.45, rand: [0.2, 0.8] },
      { key: 'aberration', label: 'Aberration', type: 'float', min: 0, max: 1, step: 0.01, default: 0.25, mod: { source: 'kick', amount: 0.3 }, rand: [0, 0.5] },
      { key: 'ghost', label: 'Ghosting', type: 'float', min: 0, max: 1, step: 0.01, default: 0.15, rand: [0, 0.4] },
      { key: 'noise', label: 'Noise', type: 'float', min: 0, max: 1, step: 0.01, default: 0.22, mod: { source: 'high', amount: 0.15 }, rand: [0.05, 0.4] },
      { key: 'jitter', label: 'Line jitter', type: 'float', min: 0, max: 1, step: 0.01, default: 0.12, mod: { source: 'snare', amount: 0.35 }, rand: [0, 0.4] },
      { key: 'wobble', label: 'Sync wobble', type: 'float', min: 0, max: 1, step: 0.01, default: 0.1, mod: { source: 'bass', amount: 0.2 }, rand: [0, 0.4] },
      { key: 'tracking', label: 'Tracking errors', type: 'float', min: 0, max: 1, step: 0.01, default: 0.2, rand: [0, 0.5] },
      { key: 'roll', label: 'Hum bar', type: 'float', min: 0, max: 1, step: 0.01, default: 0.2, rand: [0, 0.5] },
      { key: 'flicker', label: 'Flicker', type: 'float', min: 0, max: 1, step: 0.01, default: 0.15, rand: [0, 0.4] },
      { key: 'vignette', label: 'Vignette', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5, rand: [0.2, 0.8] },
    ],
  },

  output: {
    id: 'output',
    label: 'Output',
    description: 'Tone mapping and final encoding',
    fragment: output,
    params: [
      {
        key: 'tonemap',
        label: 'Tone mapping',
        type: 'select',
        default: 'vivid',
        options: [
          { value: 'vivid', label: 'Vivid' },
          { value: 'aces', label: 'Filmic (ACES)' },
          { value: 'clip', label: 'Hard clip' },
        ],
      },
      { key: 'gain', label: 'Master brightness', type: 'float', min: 0, max: 2, step: 0.01, default: 1, rand: false },
    ],
  },
} satisfies Record<string, EffectDef>;

/** Extra shader sources used by the bloom stage. */
export const BLOOM_SHADERS = { down: bloomDown, up: bloomUp };

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    const stages = next?.STAGES as Record<string, EffectDef> | undefined;
    const bloom = next?.BLOOM_SHADERS as typeof BLOOM_SHADERS | undefined;
    if (!stages || !bloom || !sameParams(Object.values(stages), Object.values(STAGES))) {
      import.meta.hot!.invalidate();
      return;
    }
    publishShaders([
      ...toHotShaders(Object.values(stages)),
      { id: 'bloom.down', fragment: bloom.down },
      { id: 'bloom.up', fragment: bloom.up },
    ]);
  });
}
