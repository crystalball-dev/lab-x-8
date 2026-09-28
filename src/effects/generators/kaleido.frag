// Kaleido: mirrored wedges around an iterated fold, drawn as glowing outlines.
#include <math>
#include <sdf>

uniform float p_segments;
uniform int p_iterations;
uniform float p_scale;
uniform float p_spin;
uniform float p_thickness;
uniform float p_zoom;
uniform int p_shape;
uniform float p_react;

float shape(vec2 q) {
  if (p_shape == 0) return min(abs(q.x), abs(q.y));
  if (p_shape == 1) return sdCircle(q, 0.4);
  if (p_shape == 2) return sdBox(q, vec2(0.38));
  if (p_shape == 3) return sdTriangle(q, 0.42);
  return sdHexagon(q, 0.4);
}

void main() {
  vec2 p = centered(v_uv) * 2.0 * p_zoom;
  float t = u_audioTime;
  p *= rot(t * p_spin * 0.15);
  float radius = length(p);
  p = kaleido(p, p_segments);

  float pulse = 1.0 + (0.22 * u_bass + 0.2 * u_kick) * p_react;
  vec2 q = p;
  float scale = 1.0;
  vec3 col = vec3(0.0);

  for (int i = 0; i < 8; i++) {
    if (i >= p_iterations) break;
    float fi = float(i);
    // Fold, then push the pieces apart. The offset breathes so the figure never repeats.
    q = abs(q) - vec2(0.62, 0.34) * pulse * (0.75 + 0.25 * sin(u_time * 0.11 + fi * 1.7));
    q *= rot(0.55 + t * 0.06 * p_spin + fi * 0.35 + u_mid * p_react * 0.25);
    q *= p_scale;
    scale *= p_scale;

    float d = shape(q) / scale;
    // Each generation of the fold listens to its own part of the spectrum.
    float band = spectrumAt(0.04 + fi * 0.11) * p_react;
    float w = p_thickness * (0.45 + 1.8 * band) / (1.0 + fi * 0.15);
    float g = glowLine(d, w);
    col += paletteAt(fi * 0.14 + radius * 0.22 - u_time * 0.04) * g * (0.35 + 1.4 * band);
  }

  // High frequencies add a fine sparkle along the outlines.
  col *= 1.0 + 0.6 * u_hat * p_react;
  // Keep the centre from burning out.
  col *= smoothstep(0.0, 0.12, radius) * 0.85 + 0.15;

  fragColor = vec4(col, 1.0);
}
