import { describe, expect, it } from 'vitest';
import { imageReach, type LayerReach } from '../src/gfx/imageReach';

const WIDE = 16 / 9;

/** A square picture in the middle at half the screen height, with every effect off. */
function still(changes: Partial<LayerReach> = {}): LayerReach {
  return {
    opacity: 1,
    fit: 1,
    scale: 0.5,
    x: 0,
    y: 0,
    rotate: 0,
    kaleido: 0,
    warp: 0,
    ripple: 0,
    displace: 0,
    glitch: 0,
    glow: 0,
    shadow: 0,
    ...changes,
  };
}

describe('Image reach', () => {
  it('is the picture itself when nothing moves it or spreads from it', () => {
    const box = imageReach(still(), 1, WIDE)!;
    expect(box.x0).toBeCloseTo(0.5 - 0.25 / WIDE);
    expect(box.x1).toBeCloseTo(0.5 + 0.25 / WIDE);
    expect(box.y0).toBeCloseTo(0.25);
    expect(box.y1).toBeCloseTo(0.75);
  });

  it('follows the position, and ends at the edges of the screen', () => {
    const box = imageReach(still({ x: 1, y: -0.5, scale: 0.2 }), 1, WIDE)!;
    expect(box.x0).toBeCloseTo(1 - 0.1 / WIDE);
    expect(box.x1).toBe(1);
    expect(box.y0).toBeCloseTo(0.15);
    expect(box.y1).toBeCloseTo(0.35);
    expect(imageReach(still({ x: 1.5, scale: 0.2 }), 1, WIDE)).toBeNull();
  });

  it('fits the picture as the shader does', () => {
    // A wide picture on a square screen: contained it is as wide as the screen, covering as high.
    const contained = imageReach(still({ scale: 1 }), 2, 1)!;
    expect([contained.x0, contained.x1, contained.y0, contained.y1]).toEqual([0, 1, 0.25, 0.75]);
    const covered = imageReach(still({ fit: 0, scale: 0.5 }), 2, 1)!;
    expect([covered.x0, covered.x1, covered.y0, covered.y1]).toEqual([0, 1, 0.25, 0.75]);
    const stretched = imageReach(still({ fit: 2, scale: 0.5 }), 2, 1)!;
    expect([stretched.x0, stretched.x1, stretched.y0, stretched.y1]).toEqual([0.25, 0.75, 0.25, 0.75]);
    expect(imageReach(still({ fit: 3, scale: 0.1 }), 2, 1)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });

  it('grows by the glow and shadow, which fade out within a third of the screen', () => {
    const plain = imageReach(still({ scale: 0.1 }), 1, WIDE)!;
    const lit = imageReach(still({ scale: 0.1, glow: 1 }), 1, WIDE)!;
    const halo = plain.y0 - lit.y0;
    expect(halo).toBeGreaterThan(0.3);
    expect(halo).toBeLessThan(0.35);
    // The shadow reaches as far, a weaker glow or a fainter picture less far.
    expect(imageReach(still({ scale: 0.1, shadow: 1 }), 1, WIDE)).toEqual(lit);
    expect(imageReach(still({ scale: 0.1, glow: 0.2 }), 1, WIDE)!.y0).toBeGreaterThan(lit.y0);
    expect(imageReach(still({ scale: 0.1, glow: 1, opacity: 0.2 }), 1, WIDE)!.y0).toBeGreaterThan(lit.y0);
  });

  it('grows by how far the picture can be pushed, torn bands only sideways', () => {
    const plain = imageReach(still({ scale: 0.1 }), 1, WIDE)!;
    const bent = imageReach(still({ scale: 0.1, warp: 0.5, ripple: 0.5, displace: 0.5 }), 1, WIDE)!;
    expect(plain.y0 - bent.y0).toBeCloseTo((0.15 + 0.078 + 0.32) / 2);
    const torn = imageReach(still({ scale: 0.1, glitch: 0.1 }), 1, WIDE)!;
    expect((plain.x0 - torn.x0) * WIDE).toBeCloseTo(0.06);
    expect(torn.y0).toBe(plain.y0);
  });

  it('covers every way a spinning or mirrored picture can point', () => {
    const corner = Math.hypot(0.5, 0.5) / 2;
    for (const changes of [{ rotate: 0.3 }, { kaleido: 6 }]) {
      const box = imageReach(still(changes), 1, WIDE)!;
      expect(box.y0).toBeCloseTo(0.5 - corner);
      expect(box.x1).toBeCloseTo(0.5 + corner / WIDE);
    }
  });
});
