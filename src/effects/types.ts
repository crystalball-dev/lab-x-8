import type { ParamDef } from '../params/types';

/**
 * An effect is a fragment shader plus the parameters it exposes.
 *
 * Every parameter with key `k` is bound automatically to a uniform named `p_k` when the shader
 * declares one. Parameters without a matching uniform are simply settings the host code reads.
 * The `p_` prefix keeps parameters apart from the engine's own `u_` uniforms.
 */
export interface EffectDef {
  /** Unique id. Doubles as the parameter group id, so parameters live at `<id>.<key>`. */
  id: string;
  label: string;
  description: string;
  /** GLSL fragment body. The shared header and `#include` chunks are added by the renderer. */
  fragment: string;
  params: ParamDef[];
}

/** Prefix shared by all generator ids. `gen.tunnel` is selected in the UI as `tunnel`. */
export const GENERATOR_PREFIX = 'gen.';
