import { BRAND } from '../brand';
import { storage } from '../util/storage';
import type { ParamStore } from './ParamStore';
import type { PresetData, PresetPicture } from './types';

const STORAGE_KEY = 'lab-x-8.presets.v1';

export interface Preset {
  id: string;
  name: string;
  builtIn: boolean;
  data: PresetData;
}

/**
 * Built-in looks. Each lists only what differs from the defaults.
 * They span the range between clean generative geometry and heavy analog degradation.
 */
const BUILT_IN: Array<{ name: string; values: PresetData['values']; mods?: PresetData['mods'] }> = [
  {
    name: 'Cathode Tunnel',
    values: {
      'layers.a': 'tunnel',
      'layers.b': 'kaleido',
      'layers.mix': 0.45,
      'layers.blend': 'screen',
      'gen.tunnel.pattern': 'grid',
      'gen.tunnel.sides': 0,
      'color.palette': 'cathode',
    },
  },
  {
    name: 'Acid Mandala',
    values: {
      'layers.a': 'kaleido',
      'layers.b': 'moire',
      'layers.mix': 0.35,
      'layers.blend': 'multiply',
      'gen.kaleido.segments': 12,
      'gen.kaleido.iterations': 5,
      'gen.kaleido.shape': 'hexagons',
      'gen.kaleido.thickness': 0.006,
      'gen.moire.frequency': 26,
      'gen.moire.sharpness': 0.4,
      'feedback.amount': 0.84,
      'feedback.zoom': 0.014,
      'feedback.rotate': 0.008,
      'feedback.hue': 0.02,
      'color.palette': 'acid',
      'color.saturation': 1.4,
      'crt.amount': 0.6,
      'crt.curvature': 0.15,
      'glitch.amount': 0.05,
    },
  },
  {
    name: 'Phosphor Ridges',
    values: {
      'layers.a': 'scope',
      'layers.b': 'none',
      'gen.scope.mode': 'ridges',
      'gen.scope.lines': 34,
      'gen.scope.amplitude': 0.5,
      'feedback.amount': 0.82,
      'feedback.zoom': 0.004,
      'feedback.rotate': 0,
      'feedback.warp': 0.05,
      'feedback.hue': 0,
      'color.palette': 'phosphor',
      'color.saturation': 1,
      'color.exposure': 2.6,
      'gen.scope.thickness': 0.0045,
      'bloom.intensity': 1.1,
      'bloom.threshold': 0.4,
      'crt.vignette': 0.3,
      'crt.amount': 1,
      'crt.scanlines': 0.7,
      'crt.pitch': 3,
      'crt.mask': 0.2,
      'crt.noise': 0.3,
      'crt.curvature': 0.45,
      'glitch.amount': 0.03,
    },
  },
  {
    name: 'Plasma Wash',
    values: {
      'layers.a': 'plasma',
      'layers.b': 'spectrum',
      'layers.mix': 0.6,
      'layers.blend': 'add',
      'gen.plasma.contours': 9,
      'gen.spectrum.mode': 'rings',
      'feedback.amount': 0.88,
      'feedback.zoom': 0.008,
      'feedback.warp': 0.5,
      'color.palette': 'vapor',
      'crt.amount': 0.7,
      'crt.bleed': 0.7,
      'glitch.amount': 0.04,
    },
  },
  {
    name: 'Particle Storm',
    values: {
      'layers.a': 'particles',
      'layers.b': 'tunnel',
      'layers.mix': 0.35,
      'layers.blend': 'add',
      'gen.particles.speed': 1.6,
      'gen.particles.swirl': 0.8,
      'gen.tunnel.pattern': 'rings',
      'gen.tunnel.sides': 6,
      'feedback.amount': 0.94,
      'feedback.zoom': 0.03,
      'feedback.rotate': 0.004,
      'feedback.mode': 'trails',
      'color.palette': 'ultraviolet',
      'bloom.intensity': 0.9,
      'crt.amount': 0.65,
    },
  },
  {
    name: 'Signal Loss',
    values: {
      'layers.a': 'spectrum',
      'layers.b': 'moire',
      'layers.mix': 0.5,
      'layers.blend': 'difference',
      'gen.spectrum.mode': 'bars',
      'feedback.amount': 0.86,
      'feedback.tap': 'glitch',
      'feedback.shiftX': 0.004,
      'feedback.zoom': 0,
      'feedback.hue': 0.03,
      'glitch.amount': 0.35,
      'glitch.blocks': 0.8,
      'glitch.crush': 0.35,
      'glitch.mosaic': 0.4,
      'glitch.tear': 0.7,
      'color.palette': 'primaries',
      'crt.amount': 1,
      'crt.tracking': 0.7,
      'crt.jitter': 0.4,
      'crt.noise': 0.45,
      'crt.ghost': 0.4,
      'crt.interlace': true,
    },
  },
  {
    name: 'Clean Geometry',
    values: {
      'layers.a': 'kaleido',
      'layers.b': 'spectrum',
      'layers.mix': 0.5,
      'layers.blend': 'screen',
      'gen.kaleido.shape': 'triangles',
      'gen.spectrum.mode': 'radial',
      'feedback.amount': 0.72,
      'feedback.zoom': 0.012,
      'color.palette': 'neon',
      'glitch.amount': 0,
      'crt.amount': 0,
      'bloom.intensity': 0.7,
    },
    mods: { 'glitch.amount': { source: 'none', amount: 0 } },
  },
];

/**
 * Brings preset data from older versions up to date, so a saved look still looks the way it
 * did when it was saved.
 *
 * Before the image could be laid on top, it was always mixed into the scene, had no glow,
 * shadow or tearing, was not lit by the kick, and its "Base layer" blend was the same as Add.
 */
export function upgradePreset(data: PresetData): PresetData {
  const values = data.values;
  const storesImage = Object.keys(values).some((path) => path.startsWith('image.'));
  if (!storesImage || 'image.placement' in values) return data;
  const upgraded: PresetData['values'] = {
    ...values,
    'image.placement': 'scene',
    'image.glow': 0,
    'image.shadow': 0,
    'image.glitch': 0,
  };
  if (values['image.blend'] === 'under') upgraded['image.blend'] = 'add';
  return {
    ...data,
    values: upgraded,
    mods: {
      ...data.mods,
      'image.brightness': data.mods?.['image.brightness'] ?? { source: 'none', amount: 0 },
      'image.glow': { source: 'none', amount: 0 },
    },
  };
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Built-in and user presets. User presets are remembered between sessions. */
export class PresetManager {
  private user: Preset[] = [];
  private revision = 0;
  /** False when stored presets could not be read, so nothing may be cleaned up on their account. */
  readonly intact: boolean = true;
  private readonly builtIn: Preset[] = BUILT_IN.map((p) => ({
    id: `builtin:${slug(p.name)}`,
    name: p.name,
    builtIn: true,
    data: { version: 1, name: p.name, values: p.values, mods: p.mods },
  }));

  constructor(private readonly params: ParamStore) {
    try {
      const raw = storage.get(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Preset[];
        if (Array.isArray(parsed)) this.user = parsed.filter((p) => p && p.data && p.name);
        else this.intact = false;
      }
    } catch {
      this.user = [];
      this.intact = false;
    }
  }

  get all(): Preset[] {
    return [...this.builtIn, ...this.user];
  }

  /** Changes whenever a preset is saved or deleted. */
  get version(): number {
    return this.revision;
  }

  find(id: string): Preset | undefined {
    return this.all.find((p) => p.id === id);
  }

  /** Applies a preset's settings. Returns the preset, whose pictures are the caller's to show. */
  apply(id: string): Preset | undefined {
    const preset = this.find(id);
    if (preset) this.params.load(upgradePreset(preset.data));
    return preset;
  }

  /**
   * Saves the current look under the given name, replacing a user preset of the same name.
   * @param pictures  the pictures on screen, by image layer, when there are any
   */
  save(name: string, pictures?: Record<string, PresetPicture>): Preset {
    const id = `user:${slug(name)}`;
    const preset: Preset = {
      id,
      name,
      builtIn: false,
      data: { ...this.params.snapshot(), name, ...(pictures ? { pictures } : {}) },
    };
    this.user = [...this.user.filter((p) => p.id !== id), preset];
    this.persist();
    return preset;
  }

  remove(id: string): void {
    this.user = this.user.filter((p) => p.id !== id);
    this.persist();
  }

  /** The kept pictures that saved presets use. */
  get pictureIds(): Set<string> {
    return new Set(this.user.flatMap((preset) => Object.values(preset.data.pictures ?? {}).map((p) => p.id)));
  }

  /**
   * Validates and applies preset JSON from a file. Returns its data, whose pictures are the
   * caller's to keep and show.
   */
  importJson(text: string): PresetData {
    const data = JSON.parse(text) as PresetData;
    if (!data || typeof data !== 'object' || typeof data.values !== 'object') {
      throw new Error(`This file is not a ${BRAND.name} preset.`);
    }
    this.params.load(upgradePreset(data));
    return data;
  }

  private persist(): void {
    this.revision++;
    storage.set(STORAGE_KEY, JSON.stringify(this.user));
  }
}
