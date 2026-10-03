import type { EffectDef } from '../effects/types';
import type { ParamStore } from '../params/ParamStore';
import type { ParamDef } from '../params/types';
import { Program } from './gl/Program';
import type { RenderTarget } from './gl/RenderTarget';
import type { Texture } from './gl/Texture';
import {
  FIRST_INPUT_UNIT,
  FULLSCREEN_VERTEX,
  GLOBALS_BINDING,
  GLOBAL_SAMPLERS,
  buildFragment,
} from './shaderlib';

type Binder = (gl: WebGL2RenderingContext, params: ParamStore) => void;

/** Uniforms with this prefix are parameters. Everything else belongs to the engine. */
const PARAM_PREFIX = 'p_';

/** Compiles a fullscreen program with the shared header and wires up the global bindings. */
export function createFullscreenProgram(
  gl: WebGL2RenderingContext,
  label: string,
  fragmentBody: string,
): Program {
  const program = new Program(gl, label, FULLSCREEN_VERTEX, buildFragment(fragmentBody));
  program.bindBlock('Globals', GLOBALS_BINDING);
  program.use();
  GLOBAL_SAMPLERS.forEach((name, unit) => program.set1i(name, unit));
  return program;
}

/** Binds up to a few named textures to the input units and draws a fullscreen triangle. */
export function drawFullscreen(
  gl: WebGL2RenderingContext,
  program: Program,
  target: RenderTarget | null,
  inputs: Record<string, Texture>,
  canvasWidth = 0,
  canvasHeight = 0,
): void {
  let width: number;
  let height: number;
  if (target) {
    target.bind();
    width = target.width;
    height = target.height;
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    width = canvasWidth;
    height = canvasHeight;
  }
  program.set2f('u_resolution', width, height);

  let unit = FIRST_INPUT_UNIT;
  for (const name in inputs) {
    inputs[name]!.bind(unit);
    program.set1i(name, unit);
    unit++;
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * One effect, ready to draw: compiled shader plus automatic parameter-to-uniform binding.
 */
export class EffectPass {
  readonly program: Program;
  private readonly binders: Binder[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly def: EffectDef,
  ) {
    this.program = createFullscreenProgram(gl, def.id, def.fragment);

    const byKey = new Map<string, ParamDef>(def.params.map((p) => [p.key, p]));
    for (const [name, uniform] of this.program.uniforms) {
      if (!name.startsWith(PARAM_PREFIX)) continue;
      const param = byKey.get(name.slice(PARAM_PREFIX.length));
      if (!param) {
        console.warn(`[${def.id}] uniform ${name} has no matching parameter and stays at zero.`);
        continue;
      }
      const path = `${def.id}.${param.key}`;
      const location = uniform.location;
      if (param.type === 'color') {
        this.binders.push((g, p) => {
          const c = p.rgb(path);
          g.uniform3f(location, c[0], c[1], c[2]);
        });
      } else if (uniform.type === gl.FLOAT) {
        this.binders.push((g, p) => g.uniform1f(location, p.num(path)));
      } else if (uniform.type === gl.INT || uniform.type === gl.BOOL) {
        this.binders.push((g, p) => g.uniform1i(location, Math.round(p.num(path))));
      } else {
        throw new Error(`[${def.id}] uniform ${name} has a type that parameters cannot drive.`);
      }
    }
  }

  /**
   * Draws the effect.
   * @param target    render target, or null for the canvas
   * @param inputs    textures by sampler uniform name
   * @param uniforms  values the engine supplies, such as the aspect of an image layer
   */
  draw(
    target: RenderTarget | null,
    inputs: Record<string, Texture>,
    params: ParamStore,
    canvasWidth = 0,
    canvasHeight = 0,
    uniforms: Record<string, number> = {},
  ): void {
    const gl = this.gl;
    this.program.use();
    for (const bind of this.binders) bind(gl, params);
    for (const name in uniforms) this.program.set1f(name, uniforms[name]!);
    drawFullscreen(gl, this.program, target, inputs, canvasWidth, canvasHeight);
  }

  dispose(): void {
    this.program.dispose();
  }
}
