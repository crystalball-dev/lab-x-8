import { Texture } from './Texture';

export type TargetFormat = 'hdr' | 'ldr';

/** A colour-only framebuffer. `hdr` targets are RGBA16F and hold linear light above 1.0. */
export class RenderTarget {
  readonly texture: Texture;
  readonly framebuffer: WebGLFramebuffer;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly format: TargetFormat,
    wrap: number = gl.CLAMP_TO_EDGE,
  ) {
    this.texture = new Texture(
      gl,
      format === 'hdr'
        ? {
            internalFormat: gl.RGBA16F,
            format: gl.RGBA,
            type: gl.HALF_FLOAT,
            wrapS: wrap,
            wrapT: wrap,
          }
        : {
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            wrapS: wrap,
            wrapT: wrap,
          },
    );
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('Could not create a framebuffer.');
    this.framebuffer = framebuffer;
  }

  get width(): number {
    return this.texture.width;
  }

  get height(): number {
    return this.texture.height;
  }

  /** Reallocates storage when the size changed. Returns true when the contents were discarded. */
  resize(width: number, height: number): boolean {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.texture.width && h === this.texture.height) return false;
    const gl = this.gl;
    this.texture.allocate(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture.handle,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete (status 0x${status.toString(16)}).`);
    }
    this.clear();
    return true;
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.texture.width, this.texture.height);
  }

  clear(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.texture.dispose();
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}

/** Two targets that swap roles every pass, for feedback and effect chains. */
export class PingPong {
  private a: RenderTarget;
  private b: RenderTarget;

  constructor(gl: WebGL2RenderingContext, format: TargetFormat, wrap?: number) {
    this.a = new RenderTarget(gl, format, wrap);
    this.b = new RenderTarget(gl, format, wrap);
  }

  /** Holds the most recently written image. */
  get read(): RenderTarget {
    return this.a;
  }

  /** The target to render into next. */
  get write(): RenderTarget {
    return this.b;
  }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  resize(width: number, height: number): boolean {
    const changedA = this.a.resize(width, height);
    const changedB = this.b.resize(width, height);
    return changedA || changedB;
  }

  clear(): void {
    this.a.clear();
    this.b.clear();
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }
}
