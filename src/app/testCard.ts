/** Draws a broadcast style test card. A ready-made image for trying the image layer. */
export function createTestCard(width = 1920, height = 1080): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const u = height / 1080;

  g.fillStyle = '#101014';
  g.fillRect(0, 0, width, height);

  // Colour bars.
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const barWidth = width / bars.length;
  bars.forEach((colour, i) => {
    g.fillStyle = colour;
    g.fillRect(Math.floor(i * barWidth), 0, Math.ceil(barWidth), height * 0.62);
  });

  // Reverse bars.
  const reverse = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
  reverse.forEach((colour, i) => {
    g.fillStyle = colour;
    g.fillRect(Math.floor(i * barWidth), height * 0.62, Math.ceil(barWidth), height * 0.08);
  });

  // Grey ramp.
  const ramp = g.createLinearGradient(0, 0, width, 0);
  ramp.addColorStop(0, '#000');
  ramp.addColorStop(1, '#fff');
  g.fillStyle = ramp;
  g.fillRect(0, height * 0.7, width, height * 0.1);

  // Resolution wedges.
  for (let i = 0; i < 6; i++) {
    const x0 = (width / 6) * i;
    const pitch = (i + 1) * 2 * u;
    for (let x = 0; x < width / 6; x += pitch * 2) {
      g.fillStyle = '#e8e8e8';
      g.fillRect(x0 + x, height * 0.8, pitch, height * 0.2);
    }
  }

  // Centre circle and cross.
  const cx = width / 2;
  const cy = height / 2;
  g.lineWidth = 6 * u;
  g.strokeStyle = '#ffffff';
  g.fillStyle = 'rgba(8, 8, 12, 0.82)';
  g.beginPath();
  g.arc(cx, cy, 300 * u, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(cx - 340 * u, cy);
  g.lineTo(cx + 340 * u, cy);
  g.moveTo(cx, cy - 340 * u);
  g.lineTo(cx, cy + 340 * u);
  g.lineWidth = 2 * u;
  g.stroke();

  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${84 * u}px ui-monospace, Consolas, monospace`;
  g.fillText('VISUALIZER', cx, cy - 60 * u);
  g.font = `400 ${38 * u}px ui-monospace, Consolas, monospace`;
  g.fillStyle = '#00ffa3';
  g.fillText('TEST CARD  1920 x 1080', cx, cy + 30 * u);
  g.fillStyle = '#ff2bd6';
  g.fillText('CH 03   PAL / NTSC', cx, cy + 90 * u);

  return canvas;
}
