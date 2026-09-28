/** Thin wrapper around a linked WebGL program with cached, typed uniform access. */

export interface UniformInfo {
  location: WebGLUniformLocation;
  type: number;
  size: number;
}

export class ShaderCompileError extends Error {
  constructor(
    readonly label: string,
    readonly log: string,
    readonly source: string,
  ) {
    super(`Shader "${label}" failed to compile:\n${annotate(log, source)}`);
    this.name = 'ShaderCompileError';
  }
}

/** Appends the offending source lines to a driver error log. */
function annotate(log: string, source: string): string {
  const lines = source.split('\n');
  const out: string[] = [log.trim()];
  const seen = new Set<number>();
  for (const match of log.matchAll(/ERROR:\s*\d+:(\d+)/g)) {
    const line = Number(match[1]);
    if (seen.has(line) || line < 1 || line > lines.length) continue;
    seen.add(line);
    out.push(`  ${line}: ${lines[line - 1]!.trim()}`);
  }
  return out.join('\n');
}

export class Program {
  readonly handle: WebGLProgram;
  readonly uniforms = new Map<string, UniformInfo>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly label: string,
    vertexSource: string,
    fragmentSource: string,
  ) {
    const vs = this.compile(gl.VERTEX_SHADER, vertexSource);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('Could not create a WebGL program.');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
      gl.deleteProgram(program);
      throw new ShaderCompileError(label, log, fragmentSource);
    }
    this.handle = program;

    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      // Uniforms that live inside a uniform block have no location.
      if (!location) continue;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, { location, type: info.type, size: info.size });
    }
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create a WebGL shader.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error';
      gl.deleteShader(shader);
      throw new ShaderCompileError(this.label, log, source);
    }
    return shader;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  has(name: string): boolean {
    return this.uniforms.has(name);
  }

  /** Binds a named uniform block to a binding point. Safe to call when the block is unused. */
  bindBlock(name: string, bindingPoint: number): void {
    const gl = this.gl;
    const index = gl.getUniformBlockIndex(this.handle, name);
    if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(this.handle, index, bindingPoint);
  }

  set1f(name: string, x: number): void {
    const u = this.uniforms.get(name);
    if (u) this.gl.uniform1f(u.location, x);
  }

  set1i(name: string, x: number): void {
    const u = this.uniforms.get(name);
    if (u) this.gl.uniform1i(u.location, x);
  }

  set2f(name: string, x: number, y: number): void {
    const u = this.uniforms.get(name);
    if (u) this.gl.uniform2f(u.location, x, y);
  }

  set3f(name: string, x: number, y: number, z: number): void {
    const u = this.uniforms.get(name);
    if (u) this.gl.uniform3f(u.location, x, y, z);
  }

  set4f(name: string, x: number, y: number, z: number, w: number): void {
    const u = this.uniforms.get(name);
    if (u) this.gl.uniform4f(u.location, x, y, z, w);
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}
