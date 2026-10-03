export interface TextureOptions {
  internalFormat: number;
  format: number;
  type: number;
  /** Magnification filter; also the minification filter unless mipmaps are enabled. */
  filter?: number;
  wrapS?: number;
  wrapT?: number;
  mipmaps?: boolean;
}

/** A 2D texture with explicit format handling. */
export class Texture {
  readonly handle: WebGLTexture;
  width = 0;
  height = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly options: TextureOptions,
  ) {
    const handle = gl.createTexture();
    if (!handle) throw new Error('Could not create a WebGL texture.');
    this.handle = handle;
    const filter = options.filter ?? gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      options.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.wrapS ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, options.wrapT ?? gl.CLAMP_TO_EDGE);
  }

  /** Allocates storage, optionally filling it with `data`. */
  allocate(width: number, height: number, data: ArrayBufferView | null = null): void {
    const { gl, options } = this;
    this.width = width;
    this.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      options.internalFormat,
      width,
      height,
      0,
      options.format,
      options.type,
      data,
    );
    if (options.mipmaps && data) gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * Uploads an image, canvas, video frame or bitmap. Bitmaps ignore both flags: they are
   * flipped and premultiplied, or not, when they are decoded.
   */
  upload(source: TexImageSource, width: number, height: number, flipY = true, premultiply = false): void {
    const { gl, options } = this;
    this.width = width;
    this.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, options.internalFormat, options.format, options.type, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (options.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Replaces a sub-rectangle. The texture must already be allocated. */
  update(x: number, y: number, width: number, height: number, data: ArrayBufferView): void {
    const { gl, options } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, options.format, options.type, data);
  }

  bind(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
  }

  dispose(): void {
    this.gl.deleteTexture(this.handle);
  }
}
