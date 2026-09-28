import { NUM_BANDS, type AudioFeatures } from '../audio/analysis/features';
import { h } from '../util/dom';

export interface HudStats {
  fps: number;
  /** CPU time spent per frame, milliseconds. */
  frameMs: number;
  /** Frames that arrived later than one and a half display intervals. */
  dropped: number;
  width: number;
  height: number;
  renderScale: number;
  gpu: string;
  source: string;
}

/** Shortens driver strings such as "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 ...)". */
export function shortGpuName(renderer: string): string {
  const inner = /ANGLE \((?:[^,]+), ([^,()]+?)(?: \(0x[0-9a-f]+\))?(?: Direct3D| OpenGL| Vulkan|,|\))/i.exec(renderer);
  return (inner?.[1] ?? renderer).trim().slice(0, 40);
}

/** On-screen statistics and level meters. Pure DOM, updated a few times per second. */
export class Hud {
  readonly element: HTMLElement;
  private readonly text: HTMLElement;
  private readonly bars: HTMLElement[] = [];
  private frame = 0;

  constructor() {
    this.text = h('div');
    const meters = h('div', { class: 'meters' });
    for (let i = 0; i < NUM_BANDS + 3; i++) {
      if (i === NUM_BANDS) meters.append(h('div', { class: 'meter-gap' }));
      const fill = h('i');
      meters.append(h('div', { class: i >= NUM_BANDS ? 'meter hit' : 'meter' }, [fill]));
      this.bars.push(fill);
    }
    this.element = h('div', { class: 'hud' }, [this.text, meters]);
  }

  set visible(value: boolean) {
    this.element.hidden = !value;
  }

  update(stats: HudStats, audio: AudioFeatures): void {
    if (this.element.hidden) return;
    const bars = this.bars;
    for (let b = 0; b < NUM_BANDS; b++) {
      bars[b]!.style.transform = `scaleY(${Math.min(1, audio.bandsFast[b]!).toFixed(3)})`;
    }
    bars[NUM_BANDS]!.style.transform = `scaleY(${Math.min(1, audio.kick).toFixed(3)})`;
    bars[NUM_BANDS + 1]!.style.transform = `scaleY(${Math.min(1, audio.snare).toFixed(3)})`;
    bars[NUM_BANDS + 2]!.style.transform = `scaleY(${Math.min(1, audio.hat).toFixed(3)})`;

    if (this.frame++ % 15 !== 0) return;
    const scale = stats.renderScale < 1 ? ` @${Math.round(stats.renderScale * 100)}%` : '';
    const bpm = `${Number(audio.bpm.toFixed(2))} BPM`;
    this.text.textContent =
      `${stats.fps.toFixed(0)} fps  ${stats.frameMs.toFixed(2)} ms  dropped ${stats.dropped}\n` +
      `${stats.width}x${stats.height}${scale}  ${stats.gpu}\n` +
      `${bpm}  ${stats.source}`;
  }
}
