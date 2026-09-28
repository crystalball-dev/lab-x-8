import type { EffectDef } from './types';

/**
 * Development-time shader hot reload.
 *
 * When an effect file is edited, its module re-executes and publishes the new definitions
 * here. The renderer recompiles just those shaders, so the picture updates while the music
 * keeps playing. In a production build none of this code runs.
 */

export interface HotShader {
  /** Effect id, or the id of an auxiliary shader such as `bloom.down`. */
  id: string;
  fragment: string;
  /** Present for real effects. Used to bind parameters. */
  def?: EffectDef;
}

type Listener = (shaders: HotShader[]) => void;

const listeners = new Set<Listener>();

export function onShadersChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishShaders(shaders: HotShader[]): void {
  for (const listener of listeners) listener(shaders);
}

export function toHotShaders(defs: EffectDef[]): HotShader[] {
  return defs.map((def) => ({ id: def.id, fragment: def.fragment, def }));
}

/** A change to the parameter list cannot be applied in place and needs a page reload. */
export function sameParams(a: EffectDef[], b: EffectDef[]): boolean {
  const signature = (defs: EffectDef[]): string =>
    JSON.stringify(defs.map((d) => [d.id, d.params]));
  return signature(a) === signature(b);
}
