/**
 * Parameter schema types.
 *
 * Every tunable value in the app is described by a ParamDef. The control panel, presets,
 * modulation routing and shader uniform binding are all generated from these descriptions,
 * so adding a parameter to an effect never requires touching UI or renderer code.
 */

export type ParamValue = number | boolean | string;

/** Signals that can drive a numeric parameter. All of them are unipolar (0..1, with headroom). */
export const MOD_SOURCES = [
  { id: 'none', label: 'None', short: '' },
  { id: 'level', label: 'Level', short: 'LVL' },
  { id: 'sub', label: 'Sub', short: 'SUB' },
  { id: 'bass', label: 'Bass', short: 'BAS' },
  { id: 'lowMid', label: 'Low mid', short: 'LMD' },
  { id: 'mid', label: 'Mid', short: 'MID' },
  { id: 'highMid', label: 'High mid', short: 'HMD' },
  { id: 'high', label: 'High', short: 'HI' },
  { id: 'kick', label: 'Kick', short: 'KCK' },
  { id: 'snare', label: 'Snare', short: 'SNR' },
  { id: 'hat', label: 'Hat', short: 'HAT' },
  { id: 'onset', label: 'Any onset', short: 'ONS' },
  { id: 'beat', label: 'Beat pulse', short: 'BT' },
  { id: 'beatSaw', label: 'Beat ramp', short: 'BT/' },
  { id: 'bar', label: 'Bar pulse', short: 'BAR' },
  { id: 'barSaw', label: 'Bar ramp', short: 'BR/' },
  { id: 'lfoSlow', label: 'LFO slow', short: 'LF1' },
  { id: 'lfoFast', label: 'LFO fast', short: 'LF2' },
] as const;

export type ModSourceId = (typeof MOD_SOURCES)[number]['id'];

export const MOD_SOURCE_INDEX: Record<ModSourceId, number> = Object.fromEntries(
  MOD_SOURCES.map((s, i) => [s.id, i]),
) as Record<ModSourceId, number>;

/** Routes a modulation source into a parameter. */
export interface ModRoute {
  source: ModSourceId;
  /** Depth as a fraction of the parameter range, -1..1. Negative values invert. */
  amount: number;
}

interface BaseDef {
  /** Unique inside its group. A shader uniform named `p_<key>` is bound automatically. */
  key: string;
  label: string;
  /** Tooltip text. */
  hint?: string;
}

export interface FloatDef extends BaseDef {
  type: 'float';
  min: number;
  max: number;
  step?: number;
  default: number;
  /** Default modulation route. */
  mod?: ModRoute;
  /** Range used by Randomize. `false` excludes the parameter from randomization. */
  rand?: [number, number] | false;
}

export interface IntDef extends BaseDef {
  type: 'int';
  min: number;
  max: number;
  default: number;
  rand?: [number, number] | false;
}

export interface BoolDef extends BaseDef {
  type: 'bool';
  default: boolean;
  rand?: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectDef extends BaseDef {
  type: 'select';
  options: SelectOption[];
  default: string;
  rand?: boolean;
}

export interface ColorDef extends BaseDef {
  type: 'color';
  /** `#rrggbb` */
  default: string;
}

export type ParamDef = FloatDef | IntDef | BoolDef | SelectDef | ColorDef;

export interface ParamGroup {
  /** Path prefix of every parameter in the group, for example `crt` or `gen.tunnel`. */
  id: string;
  label: string;
  params: ParamDef[];
  /**
   * When false the group describes the machine or the venue rather than the look
   * (input sensitivity, output resolution) and is left alone by presets.
   */
  preset?: boolean;
}

export interface PresetData {
  version: 1;
  name?: string;
  values: Record<string, ParamValue>;
  mods?: Record<string, ModRoute>;
}
