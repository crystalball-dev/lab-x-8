import type { FloatDef } from '../../params/types';
import { publishShaders, sameParams, toHotShaders } from '../hot';
import type { EffectDef } from '../types';
import kaleido from './kaleido.frag?raw';
import moire from './moire.frag?raw';
import particles from './particles.frag?raw';
import plasma from './plasma.frag?raw';
import scope from './scope.frag?raw';
import spectrum from './spectrum.frag?raw';
import tunnel from './tunnel.frag?raw';

/** Every generator exposes the same reactivity control. */
const react: FloatDef = {
  key: 'react',
  label: 'Reactivity',
  type: 'float',
  min: 0,
  max: 2,
  step: 0.01,
  default: 1,
  rand: false,
  hint: 'How strongly the audio drives this pattern',
};

/**
 * Pattern generators. To add one: write a fragment shader, describe its parameters here.
 * It then appears in both layer selectors with a generated control panel.
 */
export const GENERATORS: EffectDef[] = [
  {
    id: 'gen.tunnel',
    label: 'Tunnel',
    description: 'Polar fly-through whose walls carry the recent spectrum',
    fragment: tunnel,
    params: [
      { key: 'speed', label: 'Speed', type: 'float', min: -2, max: 3, step: 0.01, default: 0.8, rand: [0.3, 1.6] },
      { key: 'sides', label: 'Sides', type: 'float', min: 0, max: 8, step: 0.01, default: 0, hint: 'Below 3 the tunnel is round' },
      { key: 'twist', label: 'Twist', type: 'float', min: -2, max: 2, step: 0.01, default: 0.4 },
      { key: 'rings', label: 'Ring density', type: 'float', min: 0.5, max: 8, step: 0.01, default: 2.5, rand: [1, 5] },
      { key: 'segments', label: 'Segments', type: 'int', min: 2, max: 32, default: 12, rand: [4, 24] },
      {
        key: 'pattern',
        label: 'Pattern',
        type: 'select',
        default: 'grid',
        rand: true,
        options: [
          { value: 'grid', label: 'Grid' },
          { value: 'rings', label: 'Rings' },
          { value: 'checker', label: 'Checker' },
          { value: 'panels', label: 'Panels' },
          { value: 'image', label: 'Image walls' },
        ],
      },
      { key: 'glow', label: 'Core glow', type: 'float', min: 0, max: 2, step: 0.01, default: 0.8, rand: [0.3, 1.2] },
      react,
    ],
  },
  {
    id: 'gen.kaleido',
    label: 'Kaleido',
    description: 'Mirrored wedges around an iterated fold, drawn as glowing outlines',
    fragment: kaleido,
    params: [
      { key: 'segments', label: 'Mirrors', type: 'int', min: 2, max: 24, default: 8, rand: [3, 14] },
      { key: 'iterations', label: 'Iterations', type: 'int', min: 1, max: 8, default: 4, rand: [3, 6] },
      { key: 'scale', label: 'Fold scale', type: 'float', min: 1.05, max: 2.2, step: 0.01, default: 1.45, rand: [1.2, 1.8] },
      { key: 'spin', label: 'Spin', type: 'float', min: -2, max: 2, step: 0.01, default: 0.5 },
      { key: 'thickness', label: 'Line weight', type: 'float', min: 0.002, max: 0.05, step: 0.001, default: 0.007, rand: [0.004, 0.016] },
      { key: 'zoom', label: 'Zoom', type: 'float', min: 0.4, max: 3, step: 0.01, default: 1.1, rand: [0.7, 1.8] },
      {
        key: 'shape',
        label: 'Shape',
        type: 'select',
        default: 'lines',
        rand: true,
        options: [
          { value: 'lines', label: 'Lines' },
          { value: 'circles', label: 'Circles' },
          { value: 'boxes', label: 'Boxes' },
          { value: 'triangles', label: 'Triangles' },
          { value: 'hexagons', label: 'Hexagons' },
        ],
      },
      react,
    ],
  },
  {
    id: 'gen.plasma',
    label: 'Plasma',
    description: 'Domain-warped noise, the organic colour wash',
    fragment: plasma,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 0.4, max: 6, step: 0.01, default: 1.8, rand: [1, 3.5] },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 4, step: 0.01, default: 2.2, rand: [1, 3.5] },
      { key: 'speed', label: 'Speed', type: 'float', min: 0, max: 3, step: 0.01, default: 1, rand: [0.4, 1.8] },
      { key: 'contours', label: 'Contour lines', type: 'float', min: 0, max: 24, step: 0.1, default: 0, rand: [0, 14], hint: '0 turns the contour lines off' },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.5, max: 4, step: 0.01, default: 1.6, rand: [1, 2.5] },
      react,
    ],
  },
  {
    id: 'gen.particles',
    label: 'Particles',
    description: 'Point field rushing past the camera, each point tuned to a frequency',
    fragment: particles,
    params: [
      { key: 'density', label: 'Density', type: 'float', min: 0, max: 1, step: 0.01, default: 0.65, rand: [0.35, 0.9] },
      { key: 'speed', label: 'Speed', type: 'float', min: -2, max: 3, step: 0.01, default: 1, rand: [0.4, 2] },
      { key: 'size', label: 'Size', type: 'float', min: 0.2, max: 3, step: 0.01, default: 1, rand: [0.6, 1.6] },
      { key: 'layers', label: 'Layers', type: 'int', min: 1, max: 12, default: 7, rand: [4, 10] },
      { key: 'swirl', label: 'Swirl', type: 'float', min: -2, max: 2, step: 0.01, default: 0.3 },
      react,
    ],
  },
  {
    id: 'gen.spectrum',
    label: 'Spectrum',
    description: 'The classic analyser as radial bars, echo rings or mirrored bars',
    fragment: spectrum,
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'radial',
        rand: true,
        options: [
          { value: 'radial', label: 'Radial bars' },
          { value: 'rings', label: 'Echo rings' },
          { value: 'bars', label: 'Mirrored bars' },
        ],
      },
      { key: 'bars', label: 'Bars', type: 'int', min: 8, max: 128, default: 56, rand: [24, 96] },
      { key: 'radius', label: 'Radius', type: 'float', min: 0.05, max: 0.4, step: 0.001, default: 0.17, rand: [0.1, 0.25] },
      { key: 'height', label: 'Height', type: 'float', min: 0, max: 0.6, step: 0.001, default: 0.28, rand: [0.15, 0.4] },
      { key: 'spin', label: 'Spin', type: 'float', min: -3, max: 3, step: 0.01, default: 0.4 },
      { key: 'glow', label: 'Glow', type: 'float', min: 0, max: 2, step: 0.01, default: 1, rand: [0.6, 1.4] },
      react,
    ],
  },
  {
    id: 'gen.scope',
    label: 'Scope',
    description: 'Vector-monitor traces: oscilloscope, circular scope and spectrum ridgelines',
    fragment: scope,
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'ridges',
        rand: true,
        options: [
          { value: 'trace', label: 'Trace' },
          { value: 'circle', label: 'Circle' },
          { value: 'ridges', label: 'Ridgelines' },
        ],
      },
      { key: 'lines', label: 'Ridges', type: 'int', min: 4, max: 64, default: 28, rand: [14, 44] },
      { key: 'amplitude', label: 'Amplitude', type: 'float', min: 0, max: 1, step: 0.01, default: 0.4, rand: [0.25, 0.6] },
      { key: 'thickness', label: 'Line weight', type: 'float', min: 0.001, max: 0.02, step: 0.0005, default: 0.0035, rand: [0.002, 0.007] },
      react,
    ],
  },
  {
    id: 'gen.moire',
    label: 'Moire',
    description: 'Interference of circular waves from drifting emitters',
    fragment: moire,
    params: [
      { key: 'sources', label: 'Emitters', type: 'int', min: 1, max: 8, default: 3, rand: [2, 5] },
      { key: 'frequency', label: 'Frequency', type: 'float', min: 5, max: 140, step: 0.1, default: 42, rand: [20, 80] },
      { key: 'speed', label: 'Speed', type: 'float', min: 0, max: 4, step: 0.01, default: 1, rand: [0.4, 2] },
      { key: 'sharpness', label: 'Sharpness', type: 'float', min: 0, max: 1, step: 0.01, default: 0.7, rand: [0.3, 1] },
      { key: 'drift', label: 'Drift', type: 'float', min: 0, max: 1, step: 0.01, default: 0.7, rand: [0.3, 1] },
      react,
    ],
  },
];

/** Short generator names as used by the layer selectors (`tunnel` for `gen.tunnel`). */
export const GENERATOR_OPTIONS = GENERATORS.map((g) => ({
  value: g.id.slice('gen.'.length),
  label: g.label,
}));

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    const defs = next?.GENERATORS as EffectDef[] | undefined;
    if (!defs || !sameParams(defs, GENERATORS)) import.meta.hot!.invalidate();
    else publishShaders(toHotShaders(defs));
  });
}
