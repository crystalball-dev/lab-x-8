import { createFullscreenProgram, drawFullscreen } from './EffectPass';
import type { Program } from './gl/Program';
import type { Texture } from './gl/Texture';
import shader from './transition.frag?raw';

/** Blends the finished pictures of two looks onto the canvas. */
export class TransitionPass {
  private readonly program: Program;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createFullscreenProgram(gl, 'transition', shader);
  }

  /**
   * @param progress 0 shows `from` only, 1 shows `to` only
   * @param style    index into TRANSITION_STYLES
   */
  draw(from: Texture, to: Texture, progress: number, style: number, width: number, height: number): void {
    this.program.use();
    this.program.set1f('u_progress', progress);
    this.program.set1i('u_style', Math.round(style));
    drawFullscreen(this.gl, this.program, null, { u_from: from, u_to: to }, width, height);
  }

  dispose(): void {
    this.program.dispose();
  }
}
