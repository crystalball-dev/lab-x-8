import { GENERATORS } from '../effects/generators';
import { onShadersChanged, type HotShader } from '../effects/hot';
import { IMAGE_LAYERS, STAGES } from '../effects/stages';
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
import { TransitionPass } from './TransitionPass';

const NOISE_SIZE = 256;
const PALETTE_WIDTH = 256;
/** Images larger than this on either side are downscaled before upload. */
export const MAX_IMAGE_SIZE = 4096;

export interface ImageSource {
  source: TexImageSource;
  width: number;
  height: number;
  /**
   * Whether the upload has to flip the rows. Bitmaps ignore the GL flip and premultiply flags,
   * so they are decoded already flipped and premultiplied, and pass false.
   */
  flipY: boolean;
}

/** One look giving way to another, as the look cycle plays them. */
export interface Transition {
  /** Changes with every new transition, which tells the renderer that one has begun. */
  id: number;
  /** The look fading out. The renderer's own parameters hold the look fading in. */
  from: ParamStore;
  /** 0 when the transition starts, 1 when the new look has taken over. */
  progress: number;
  /** Index into TRANSITION_STYLES. */
  style: number;
}

/** A picture of one image layer. Aspect 0 means the layer is empty. */
interface Picture {
  readonly texture: Texture;
  aspect: number;
}

/** What a look carries from one frame to the next, apart from its parameters. */
class LookState {
  readonly history: RenderTarget;
  readonly palette: Texture;
  paletteDirty = true;

  constructor(gl: WebGL2RenderingContext, format: TargetFormat) {
    this.history = new RenderTarget(gl, format);
    this.palette = new Texture(gl, {
      internalFormat: gl.SRGB8_ALPHA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      wrapS: gl.MIRRORED_REPEAT,
    });
    this.palette.allocate(PALETTE_WIDTH, 1, new Uint8Array(PALETTE_WIDTH * 4));
  }

  dispose(): void {
    this.history.dispose();
    this.palette.dispose();
  }
}

/**
 * Runs the render pipeline:
 *
 *   generator A ─┐
 *   generator B ─┴─ layers ─ image* ─ feedback ─ glitch ─ colour ─ bloom ─ image* ─ CRT ─ output
 *                                        ▲      │        │                │
 *                                        └──────┴────────┴── history ◄────┘ (selectable tap)
 *
 *   * The image runs at one of the two points: in the scene, where every effect acts on it,
 *     or on top, where only the CRT screen does.
 *
 * Everything up to the image on top runs at scene resolution in linear HDR. CRT and output run
 * at the full output resolution so scanlines and the phosphor mask stay pixel exact.
 *
 * During a transition the whole pipeline runs twice, once for each look with its own feedback
 * history and palette, and the two finished pictures are blended onto the canvas.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;
  /** Called when a hot-reloaded shader fails to compile. The previous version stays active. */
  onShaderError: (message: string) => void = () => undefined;

  /** Every effect by id: generators (`gen.*`) and stages. */
  private readonly passes = new Map<string, EffectPass>();
  private readonly bloom: BloomStage;
  private readonly transitionPass: TransitionPass;

  private readonly genA: RenderTarget;
  private readonly genB: RenderTarget;
  private readonly chain: PingPong;
  private readonly full: RenderTarget;
  /** The look on screen, or fading in. */
  private readonly current: LookState;
  /** The look fading out during a transition. */
  private readonly fading: LookState;
  /** Finished pictures of the two looks of a transition, before they are blended. */
  private readonly outgoing: RenderTarget;
  private readonly incoming: RenderTarget;

  private readonly audioTextures: AudioTextures;
  private readonly globals: GlobalsBuffer;
  private readonly noise: Texture;
  /** One per image layer. */
  private readonly pictures: Picture[];
  private readonly vao: WebGLVertexArrayObject;

  private transitionId = 0;
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
    for (const def of [...GENERATORS, ...Object.values(STAGES), ...IMAGE_LAYERS.slice(1)]) {
      this.passes.set(def.id, new EffectPass(gl, def));
    }
    this.bloom = new BloomStage(gl);
    this.transitionPass = new TransitionPass(gl);

    this.genA = new RenderTarget(gl, format);
    this.genB = new RenderTarget(gl, format);
    this.chain = new PingPong(gl, format);
    this.full = new RenderTarget(gl, format);
    this.current = new LookState(gl, format);
    this.fading = new LookState(gl, format);
    this.outgoing = new RenderTarget(gl, 'ldr');
    this.incoming = new RenderTarget(gl, 'ldr');

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

    // Premultiplied and still sRGB encoded, so transparent edges filter and mip cleanly.
    // Shaders read them through imageAt(), which undoes both.
    this.pictures = IMAGE_LAYERS.map(() => {
      const texture = new Texture(gl, {
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        wrapS: gl.MIRRORED_REPEAT,
        wrapT: gl.MIRRORED_REPEAT,
        mipmaps: true,
      });
      texture.allocate(1, 1, new Uint8Array([0, 0, 0, 255]));
      return { texture, aspect: 0 };
    });

    this.subscriptions.push(
      params.subscribe((path) => {
        if (path === '*' || path.startsWith('color.palette') || path.startsWith('color.custom')) {
          this.current.paletteDirty = true;
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
    for (const look of [this.current, this.fading]) {
      look.history.resize(sw, sh);
      look.history.clear();
    }
    this.full.resize(w, h);
    this.outgoing.resize(w, h);
    this.incoming.resize(w, h);
    this.bloom.resize(sw, sh);
  }

  /** Installs a picture in an image layer, or empties the layer when `image` is null. */
  setImage(layer: number, image: ImageSource | null): void {
    const picture = this.pictures[layer]!;
    if (!image) {
      picture.texture.allocate(1, 1, new Uint8Array([0, 0, 0, 255]));
      picture.aspect = 0;
      return;
    }
    picture.texture.upload(image.source, image.width, image.height, image.flipY, true);
    picture.aspect = image.width / image.height;
  }

  /** The picture the tunnel's image walls show: the first one loaded. */
  private get wall(): Picture {
    return this.pictures.find((p) => p.aspect > 0) ?? this.pictures[0]!;
  }

  /** Clears all temporal state: feedback history and the spectrogram. */
  reset(): void {
    this.current.history.clear();
    this.fading.history.clear();
    this.chain.clear();
    this.audioTextures.reset();
  }

  /**
   * Draws a frame of the look in the renderer's parameters, or of a transition from another
   * look into it.
   */
  render(frame: FrameState, transition: Transition | null = null): void {
    const gl = this.gl;
    if (this.outputWidth === 0 || gl.isContextLost()) return;

    this.audioTextures.update(frame.audio, frame.dt);
    this.globals.update(frame, {
      historyRow: this.audioTextures.historyRow,
      historyFraction: this.audioTextures.historyFraction,
      imageAspect: this.wall.aspect,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
    });

    gl.bindVertexArray(this.vao);
    this.audioTextures.spectrum.bind(0);
    this.audioTextures.waveform.bind(1);
    this.audioTextures.spectrogram.bind(2);
    this.noise.bind(3);

    if (!transition) {
      this.drawLook(this.params, this.current, null);
      return;
    }
    if (transition.id !== this.transitionId) {
      // The look fading out carries on from the same picture as the one fading in.
      this.transitionId = transition.id;
      this.copy(this.current.history, this.fading.history);
      this.fading.paletteDirty = true;
    }
    this.drawLook(transition.from, this.fading, this.outgoing);
    this.drawLook(this.params, this.current, this.incoming);
    this.transitionPass.draw(
      this.outgoing.texture,
      this.incoming.texture,
      transition.progress,
      transition.style,
      this.outputWidth,
      this.outputHeight,
    );
  }

  /** Runs the whole pipeline for one look into `target`, or onto the canvas when it is null. */
  private drawLook(p: ParamStore, look: LookState, target: RenderTarget | null): void {
    if (look.paletteDirty) this.updatePalette(look, p);
    look.palette.bind(4);
    this.wall.texture.bind(5);

    const chain = this.chain;
    // Runs one stage of the chain and returns its result.
    const stage = (id: string, inputs: Record<string, Texture>, uniforms?: Record<string, number>): Texture => {
      this.pass(id).draw(chain.write, inputs, p, 0, 0, uniforms);
      chain.swap();
      return chain.read.texture;
    };
    // Draws the image layers placed at one point of the chain, in layer order.
    const images = (placement: string): void => {
      IMAGE_LAYERS.forEach((layer, i) => {
        const picture = this.pictures[i]!;
        if (picture.aspect === 0 || p.num(`${layer.id}.opacity`) <= 0.001) return;
        if (p.str(`${layer.id}.placement`) !== placement) return;
        picture.texture.bind(5);
        current = stage(layer.id, { u_input: current }, { u_layerAspect: picture.aspect });
      });
    };

    // --- generators ----------------------------------------------------------------------------
    this.pass(`gen.${p.str('layers.a')}`).draw(this.genA, {}, p);
    let current = this.genA.texture;
    const layerB = p.str('layers.b');
    if (layerB !== 'none' && p.num('layers.mix') > 0.001) {
      this.pass(`gen.${layerB}`).draw(this.genB, {}, p);
      current = stage('layers', { u_input: current, u_inputB: this.genB.texture });
    }

    // --- images in the scene ---------------------------------------------------------------------
    images('scene');

    // --- feedback ------------------------------------------------------------------------------
    const feedbackOn = p.num('feedback.amount') > 0.001;
    const tap = p.str('feedback.tap');
    if (feedbackOn) {
      current = stage('feedback', { u_input: current, u_feedback: look.history.texture });
      if (tap === 'scene') this.copy(chain.read, look.history);
    }

    // --- corruption, then grading --------------------------------------------------------------
    // Grading comes after the glitch tap: gain inside a feedback loop would run away to white.
    if (p.num('glitch.amount') > 0.001) {
      current = stage('glitch', { u_input: current });
      if (feedbackOn && tap === 'glitch') this.copy(chain.read, look.history);
    } else if (feedbackOn && tap === 'glitch') {
      this.copy(chain.read, look.history);
    }
    current = stage('color', { u_input: current });

    // --- bloom ---------------------------------------------------------------------------------
    if (p.num('bloom.intensity') > 0.001) {
      this.bloom.render(current, chain.write, p, this.pass('bloom'));
      chain.swap();
      current = chain.read.texture;
    }
    if (feedbackOn && tap === 'final') this.copy(chain.read, look.history);

    // --- images on top ----------------------------------------------------------------------------
    // After every effect that would smear or recolour them, and outside the feedback loop, but
    // still on the screen they are shown on.
    images('top');

    // --- display -------------------------------------------------------------------------------
    if (p.num('crt.amount') > 0.001) {
      this.pass('crt').draw(this.full, { u_input: current }, p);
      current = this.full.texture;
    }
    this.pass('output').draw(target, { u_input: current }, p, this.outputWidth, this.outputHeight);
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

  /** Copies a scene-sized target into another, such as a feedback history. */
  private copy(source: RenderTarget, destination: RenderTarget): void {
    const gl = this.gl;
    const w = this.sceneWidth;
    const h = this.sceneHeight;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination.framebuffer);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  private updatePalette(look: LookState, p: ParamStore): void {
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
    look.palette.update(0, 0, PALETTE_WIDTH, 1, renderPalette(stops, PALETTE_WIDTH));
    look.paletteDirty = false;
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    for (const pass of this.passes.values()) pass.dispose();
    this.bloom.dispose();
    this.transitionPass.dispose();
    this.genA.dispose();
    this.genB.dispose();
    this.chain.dispose();
    this.full.dispose();
    this.current.dispose();
    this.fading.dispose();
    this.outgoing.dispose();
    this.incoming.dispose();
    this.audioTextures.dispose();
    this.globals.dispose();
    this.noise.dispose();
    for (const picture of this.pictures) picture.texture.dispose();
    this.gl.deleteVertexArray(this.vao);
  }
}
