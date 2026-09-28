import header from './header.glsl?raw';
import color from './chunks/color.glsl?raw';
import math from './chunks/math.glsl?raw';
import sdf from './chunks/sdf.glsl?raw';

/** Reusable GLSL chunks, pulled in with `#include <name>`. */
const CHUNKS: Record<string, string> = { math, color, sdf };

/** Registers an additional chunk so new effects can share code. */
export function registerChunk(name: string, source: string): void {
  CHUNKS[name] = source;
}

const INCLUDE = /^[ \t]*#include\s+<([\w-]+)>[ \t]*$/gm;

/**
 * Builds a complete fragment shader: shared header, resolved includes, then the effect body.
 * Each chunk is included at most once, so effects and chunks may include freely.
 */
export function buildFragment(body: string): string {
  const included = new Set<string>();
  const resolve = (source: string): string =>
    source.replace(INCLUDE, (_match, name: string) => {
      if (included.has(name)) return '';
      const chunk = CHUNKS[name];
      if (chunk === undefined) throw new Error(`Unknown shader chunk <${name}>`);
      included.add(name);
      return resolve(chunk);
    });
  return `${header}\n${resolve(body)}`;
}

/** Fullscreen triangle generated from gl_VertexID. No vertex buffers required. */
export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Texture units reserved for the global samplers declared in the header. */
export const GLOBAL_SAMPLERS = [
  'u_spectrum',
  'u_waveform',
  'u_spectrogram',
  'u_noise',
  'u_palette',
  'u_image',
] as const;

/** First texture unit available for per-pass inputs. */
export const FIRST_INPUT_UNIT = GLOBAL_SAMPLERS.length;

/** Binding point of the Globals uniform block. */
export const GLOBALS_BINDING = 0;
/** Number of vec4 entries in the Globals block. Must match header.glsl. */
export const GLOBALS_VEC4_COUNT = 9;
