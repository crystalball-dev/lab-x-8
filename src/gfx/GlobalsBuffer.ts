import { GLOBALS_BINDING, GLOBALS_VEC4_COUNT } from './shaderlib';
import type { FrameState } from './FrameState';

export interface GlobalsExtras {
  /** Normalized texture coordinate of the newest spectrogram row. */
  historyRow: number;
  /** Scroll progress towards the next row, in texture coordinates. */
  historyFraction: number;
  /** Width / height of the user image, or 0 when none is loaded. */
  imageAspect: number;
  outputWidth: number;
  outputHeight: number;
}

/**
 * The `Globals` uniform block shared by every shader.
 * It is filled once per frame, so individual passes never set timing or audio uniforms.
 * The layout must match header.glsl: nine vec4 values, std140.
 */
export class GlobalsBuffer {
  private readonly buffer: WebGLBuffer;
  private readonly data = new Float32Array(GLOBALS_VEC4_COUNT * 4);

  constructor(private readonly gl: WebGL2RenderingContext) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Could not create the globals uniform buffer.');
    this.buffer = buffer;
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.bufferData(gl.UNIFORM_BUFFER, this.data, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, GLOBALS_BINDING, buffer);
  }

  update(frame: FrameState, extras: GlobalsExtras): void {
    const d = this.data;
    const a = frame.audio;
    // g_time
    d[0] = frame.time;
    d[1] = frame.dt;
    d[2] = frame.frame;
    d[3] = frame.audioTime;
    // g_beat
    d[4] = a.beatPhase;
    d[5] = a.beatPulse;
    d[6] = a.beatCount;
    d[7] = a.bpm;
    // g_hits
    d[8] = a.onset;
    d[9] = a.kick;
    d[10] = a.snare;
    d[11] = a.hat;
    // g_misc
    d[12] = a.level;
    d[13] = a.barPhase;
    d[14] = extras.historyRow;
    d[15] = extras.imageAspect;
    // g_bandsA, g_bandsB
    d[16] = a.bands[0]!;
    d[17] = a.bands[1]!;
    d[18] = a.bands[2]!;
    d[19] = a.bands[3]!;
    d[20] = a.bands[4]!;
    d[21] = a.bands[5]!;
    // g_fastA, g_fastB
    d[24] = a.bandsFast[0]!;
    d[25] = a.bandsFast[1]!;
    d[26] = a.bandsFast[2]!;
    d[27] = a.bandsFast[3]!;
    d[28] = a.bandsFast[4]!;
    d[29] = a.bandsFast[5]!;
    // g_frame
    d[32] = extras.outputWidth;
    d[33] = extras.outputHeight;
    d[34] = extras.outputWidth / extras.outputHeight;
    d[35] = extras.historyFraction;

    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, d);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}
