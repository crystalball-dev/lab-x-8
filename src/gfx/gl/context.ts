/** WebGL2 context creation and capability detection. */

export interface GLCaps {
  /** True when floating point render targets are available (HDR pipeline). */
  floatTargets: boolean;
  maxTextureSize: number;
  /** Human readable GPU name when the browser exposes it. */
  renderer: string;
}

export interface GLContext {
  gl: WebGL2RenderingContext;
  caps: GLCaps;
}

export function createGLContext(canvas: HTMLCanvasElement | OffscreenCanvas): GLContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    // Picks the discrete GPU on hybrid-graphics machines.
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) {
    throw new Error('WebGL2 is not available. Enable hardware acceleration in your browser.');
  }

  const floatTargets =
    gl.getExtension('EXT_color_buffer_float') !== null ||
    gl.getExtension('EXT_color_buffer_half_float') !== null;
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  return {
    gl,
    caps: {
      floatTargets,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      renderer,
    },
  };
}
