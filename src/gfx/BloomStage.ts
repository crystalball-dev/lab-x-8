import { BLOOM_SHADERS } from '../effects/stages';
import type { ParamStore } from '../params/ParamStore';
import { createFullscreenProgram, drawFullscreen, type EffectPass } from './EffectPass';
import type { Program } from './gl/Program';
import { RenderTarget } from './gl/RenderTarget';
import type { Texture } from './gl/Texture';

const MAX_LEVELS = 6;
const MIN_LEVEL_SIZE = 12;

/**
 * Multi-resolution bloom: bright-pass, progressive downsample, progressive upsample, combine.
 * All intermediate levels are at half resolution or lower, so the whole stage costs less than
 * one fullscreen pass.
 */
export class BloomStage {
  private down: Program;
  private up: Program;
  private downLevels: RenderTarget[] = [];
  private upLevels: RenderTarget[] = [];
  private width = 0;
  private height = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.down = createFullscreenProgram(gl, 'bloom.down', BLOOM_SHADERS.down);
    this.up = createFullscreenProgram(gl, 'bloom.up', BLOOM_SHADERS.up);
  }

  /** Replaces one of the internal shaders. Used by hot reload. Throws when it does not compile. */
  replaceShader(id: string, fragment: string): void {
    if (id !== 'bloom.down' && id !== 'bloom.up') return;
    const program = createFullscreenProgram(this.gl, id, fragment);
    if (id === 'bloom.down') {
      this.down.dispose();
      this.down = program;
    } else {
      this.up.dispose();
      this.up = program;
    }
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.disposeLevels();

    let w = width;
    let h = height;
    for (let i = 0; i < MAX_LEVELS; i++) {
      w = Math.floor(w / 2);
      h = Math.floor(h / 2);
      if (w < MIN_LEVEL_SIZE || h < MIN_LEVEL_SIZE) break;
      const level = new RenderTarget(this.gl, 'hdr');
      level.resize(w, h);
      this.downLevels.push(level);
    }
    for (let i = 0; i < this.downLevels.length - 1; i++) {
      const level = new RenderTarget(this.gl, 'hdr');
      level.resize(this.downLevels[i]!.width, this.downLevels[i]!.height);
      this.upLevels.push(level);
    }
  }

  /**
   * @param combine  the pass that adds the blurred light back onto the scene
   */
  render(input: Texture, output: RenderTarget, params: ParamStore, combine: EffectPass): void {
    const gl = this.gl;
    const levels = this.downLevels;
    if (levels.length < 2) return;

    const { down, up } = this;
    down.use();
    down.set1f('u_knee', 0.25);
    let source = input;
    for (let i = 0; i < levels.length; i++) {
      down.set1f('u_threshold', i === 0 ? params.num('bloom.threshold') : -1);
      down.set2f('u_texel', 1 / source.width, 1 / source.height);
      drawFullscreen(gl, down, levels[i]!, { u_input: source });
      source = levels[i]!.texture;
    }

    up.use();
    up.set1f('u_radius', params.num('bloom.radius'));
    for (let i = levels.length - 2; i >= 0; i--) {
      up.set2f('u_texel', 1 / source.width, 1 / source.height);
      drawFullscreen(gl, up, this.upLevels[i]!, { u_input: source, u_inputB: levels[i]!.texture });
      source = this.upLevels[i]!.texture;
    }

    combine.draw(output, { u_input: input, u_inputB: source }, params);
  }

  private disposeLevels(): void {
    for (const level of this.downLevels) level.dispose();
    for (const level of this.upLevels) level.dispose();
    this.downLevels = [];
    this.upLevels = [];
  }

  dispose(): void {
    this.disposeLevels();
    this.down.dispose();
    this.up.dispose();
  }
}
