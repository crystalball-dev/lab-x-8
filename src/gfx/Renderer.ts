import { GENERATORS } from '../effects/generators';
import { onShadersChanged, type HotShader } from '../effects/hot';
import { STAGES } from '../effects/stages';
import type { ParamStore } from '../params/ParamStore';
import { CUSTOM_PALETTE, findPalette, renderPalette } from '../params/palettes';
import { createRng } from '../util/math';
import { AudioTextures } from './AudioTextures';
import { BloomStage } from './BloomStage';
import { EffectPass } from './EffectPass';
import type { FrameState } from './FrameState';
import { GlobalsBuffer } from './GlobalsBuffer';
import { createGLContext, type GLCaps } from './gl/context';
import { PingPong, RenderTarget, type TargetFormat } from './gl/RenderTarget';
import { Texture } from './gl/Texture';

const NOISE_SIZE = 256;
const PALETTE_WIDTH = 256;
/** Images larger than this on either side are downscaled before upload. */
export const MAX_IMAGE_SIZE = 4096;

export interface ImageSource {
  source: TexImageSource;
  width: number;
  height: number;
  /**
   * Whether the upload has to flip the rows. Bitmaps ignore the GL flip flag, so they are
   * decoded already flipped and pass false.
   */
  flipY: boolean;
}

/**
 * Runs the render pipeline:
 *
 *   generator A ─┐
 *   generator B ─┴─ layers ─ image ─ feedback ─ glitch ─ colour ─ bloom ─ CRT ─ output
 *                                       ▲      │        │                │
 *                                       └──────┴────────┴── history ◄────┘ (selectable tap)
 *
 * Everything up to bloom runs at scene resolution in linear HDR. CRT and output run at the
 * full output resolution so scanlines and the phosphor mask stay pixel exact.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;
  /** Called when a hot-reloaded shader fails to compile. The previous version stays active. */
  onShaderError: (message: string) => void = () => undefined;

  /** Every effect by id: generators (`gen.*`) and stages. */
  private readonly passes = new Map<string, EffectPass>();
  private readonly bloom: BloomStage;

  private readonly genA: RenderTarget;
  private readonly genB: RenderTarget;
  private readonly chain: PingPong;
  private readonly history: RenderTarget;
  private readonly full: RenderTarget;

  private readonly audioTextures: AudioTextures;
  private readonly globals: GlobalsBuffer;
  private readonly noise: Texture;
  private readonly palette: Texture;
  private readonly imageTexture: Texture;
  private readonly vao: WebGLVertexArrayObject;

  private imageAspect = 0;
  private paletteDirty = true;
  private outputWidth = 0;
  private outputHeight = 0;
  private sceneWidth = 0;
  private sceneHeight = 0;
  private readonly subscriptions: Array<() => void> = [];

  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly params: ParamStore,
  ) {
    const { gl, caps } = createGLContext(canvas);
    this.gl = gl;
    this.caps = caps;
    const format: TargetFormat = caps.floatTargets ? 'hdr' : 'ldr';

    // Attribute-less fullscreen triangle still needs a bound vertex array.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create a vertex array.');
    this.vao = vao;
    gl.bindVertexArray(vao);

    this.globals = new GlobalsBuffer(gl);

    // Compile everything up front so switching patterns during a set never hitches.
    for (const def of [...GENERATORS, ...Object.values(STAGES)]) {
      this.passes.set(def.id, new EffectPass(gl, def));
    }
    this.bloom = new BloomStage(gl);

    this.genA = new RenderTarget(gl, format);
    this.genB = new RenderTarget(gl, format);
    this.chain = new PingPong(gl, format);
    this.history = new RenderTarget(gl, format);
    this.full = new RenderTarget(gl, format);

    this.audioTextures = new AudioTextures(gl);

    this.noise = new Texture(gl, {
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      wrapS: gl.REPEAT,
      wrapT: gl.REPEAT,
    });
    const rng = createRng(0xc0ffee);
    const noiseData = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.floor(rng() * 256);
    this.noise.allocate(NOISE_SIZE, NOISE_SIZE, noiseData);

    this.palette = new Texture(gl, {
      internalFormat: gl.SRGB8_ALPHA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      wrapS: gl.MIRRORED_REPEAT,
    });
    this.palette.allocate(PALETTE_WIDTH, 1, new Uint8Array(PALETTE_WIDTH * 4));

    this.imageTexture = new Texture(gl, {
      internalFormat: gl.SRGB8_ALPHA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      wrapS: gl.MIRRORED_REPEAT,
      wrapT: gl.MIRRORED_REPEAT,
      mipmaps: true,
    });
    this.imageTexture.allocate(1, 1, new Uint8Array([0, 0, 0, 255]));

    this.subscriptions.push(
      params.subscribe((path) => {
        if (path === '*' || path.startsWith('color.palette') || path.startsWith('color.custom')) {
          this.paletteDirty = true;
        }
      }),
      onShadersChanged((shaders) => this.reloadShaders(shaders)),
    );
  }

  get width(): number {
    return this.outputWidth;
  }

  get height(): number {
    return this.outputHeight;
  }

  get hasImage(): boolean {
    return this.imageAspect > 0;
  }

  /**
   * Sets the output resolution and the internal scene scale.
   * Resizing clears the feedback history.
   */
  resize(width: number, height: number, renderScale = 1): void {
    const w = Math.max(16, Math.round(width));
    const h = Math.max(16, Math.round(height));
    const sw = Math.max(16, Math.round(w * renderScale));
    const sh = Math.max(16, Math.round(h * renderScale));
    if (
      w === this.outputWidth &&
      h === this.outputHeight &&
      sw === this.sceneWidth &&
      sh === this.sceneHeight
    ) {
      return;
    }
    this.outputWidth = w;
    this.outputHeight = h;
    this.sceneWidth = sw;
    this.sceneHeight = sh;
    this.canvas.width = w;
    this.canvas.height = h;

    this.genA.resize(sw, sh);
    this.genB.resize(sw, sh);
    this.chain.resize(sw, sh);
    this.history.resize(sw, sh);
    this.history.clear();
    this.full.resize(w, h);
    this.bloom.resize(sw, sh);
  }

  /** Installs the user image, or removes it when `image` is null. */
  setImage(image: ImageSource | null): void {
    if (!image) {
      this.imageTexture.allocate(1, 1, new Uint8Array([0, 0, 0, 255]));
      this.imageAspect = 0;
      return;
    }
    this.imageTexture.upload(image.source, image.width, image.height, image.flipY);
    this.imageAspect = image.width / image.height;
  }

  /** Clears all temporal state: feedback history and the spectrogram. */
  reset(): void {
    this.history.clear();
    this.chain.clear();
    this.audioTextures.reset();
  }

  render(frame: FrameState): void {
    const gl = this.gl;
    const p = this.params;
    if (this.outputWidth === 0 || gl.isContextLost()) return;

    this.audioTextures.update(frame.audio, frame.dt);
    if (this.paletteDirty) this.updatePalette();
    this.globals.update(frame, {
      historyRow: this.audioTextures.historyRow,
      historyFraction: this.audioTextures.historyFraction,
      imageAspect: this.imageAspect,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
    });

    gl.bindVertexArray(this.vao);
    this.audioTextures.spectrum.bind(0);
    this.audioTextures.waveform.bind(1);
    this.audioTextures.spectrogram.bind(2);
    this.noise.bind(3);
    this.palette.bind(4);
    this.imageTexture.bind(5);

    const chain = this.chain;
    // Runs one stage of the chain and returns its result.
    const stage = (id: string, inputs: Record<string, Texture>): Texture => {
      this.pass(id).draw(chain.write, inputs, p);
      chain.swap();
      return chain.read.texture;
    };

    // --- generators ----------------------------------------------------------------------------
    this.pass(`gen.${p.str('layers.a')}`).draw(this.genA, {}, p);
    let current = this.genA.texture;
    const layerB = p.str('layers.b');
    if (layerB !== 'none' && p.num('layers.mix') > 0.001) {
      this.pass(`gen.${layerB}`).draw(this.genB, {}, p);
      current = stage('layers', { u_input: current, u_inputB: this.genB.texture });
    }

    // --- image ---------------------------------------------------------------------------------
    if (this.hasImage && p.num('image.opacity') > 0.001) {
      current = stage('image', { u_input: current });
    }

    // --- feedback ------------------------------------------------------------------------------
    const feedbackOn = p.num('feedback.amount') > 0.001;
    const tap = p.str('feedback.tap');
    if (feedbackOn) {
      current = stage('feedback', { u_input: current, u_feedback: this.history.texture });
      if (tap === 'scene') this.storeHistory(chain.read);
    }

    // --- corruption, then grading --------------------------------------------------------------
    // Grading comes after the glitch tap: gain inside a feedback loop would run away to white.
    if (p.num('glitch.amount') > 0.001) {
      current = stage('glitch', { u_input: current });
      if (feedbackOn && tap === 'glitch') this.storeHistory(chain.read);
    } else if (feedbackOn && tap === 'glitch') {
      this.storeHistory(chain.read);
    }
    current = stage('color', { u_input: current });

    // --- bloom ---------------------------------------------------------------------------------
    if (p.num('bloom.intensity') > 0.001) {
      this.bloom.render(current, chain.write, p, this.pass('bloom'));
      chain.swap();
      current = chain.read.texture;
    }
    if (feedbackOn && tap === 'final') this.storeHistory(chain.read);

    // --- display -------------------------------------------------------------------------------
    if (p.num('crt.amount') > 0.001) {
      this.pass('crt').draw(this.full, { u_input: current }, p);
      current = this.full.texture;
    }
    this.pass('output').draw(null, { u_input: current }, p, this.outputWidth, this.outputHeight);
  }

  private pass(id: string): EffectPass {
    const pass = this.passes.get(id);
    if (!pass) throw new Error(`Unknown effect "${id}".`);
    return pass;
  }

  /** Recompiles edited shaders. A shader that fails to compile keeps its previous version. */
  private reloadShaders(shaders: HotShader[]): void {
    for (const shader of shaders) {
      try {
        if (!shader.def) {
          this.bloom.replaceShader(shader.id, shader.fragment);
          continue;
        }
        const existing = this.passes.get(shader.id);
        if (existing && existing.def.fragment === shader.fragment) continue;
        const next = new EffectPass(this.gl, shader.def);
        existing?.dispose();
        this.passes.set(shader.id, next);
        console.info(`[hot] reloaded ${shader.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        this.onShaderError(message);
      }
    }
  }

  private storeHistory(source: RenderTarget): void {
    const gl = this.gl;
    const w = this.sceneWidth;
    const h = this.sceneHeight;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.history.framebuffer);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  private updatePalette(): void {
    const p = this.params;
    const id = p.str('color.palette');
    const stops =
      id === CUSTOM_PALETTE
        ? [
            p.str('color.custom1'),
            p.str('color.custom2'),
            p.str('color.custom3'),
            p.str('color.custom4'),
          ]
        : (findPalette(id)?.stops ?? ['#000000', '#ffffff']);
    this.palette.update(0, 0, PALETTE_WIDTH, 1, renderPalette(stops, PALETTE_WIDTH));
    this.paletteDirty = false;
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    for (const pass of this.passes.values()) pass.dispose();
    this.bloom.dispose();
    this.genA.dispose();
    this.genB.dispose();
    this.chain.dispose();
    this.history.dispose();
    this.full.dispose();
    this.audioTextures.dispose();
    this.globals.dispose();
    this.noise.dispose();
    this.palette.dispose();
    this.imageTexture.dispose();
    this.gl.deleteVertexArray(this.vao);
  }
}
