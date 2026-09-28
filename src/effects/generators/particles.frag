// Particles: layered point field rushing past the camera. Every particle is tuned to a frequency.
#include <math>

uniform float p_density;
uniform float p_speed;
uniform float p_size;
uniform int p_layers;
uniform float p_swirl;
uniform float p_react;

void main() {
  vec2 p = centered(v_uv);
  float t = u_audioTime * p_speed * 0.12;
  vec3 col = vec3(0.0);
  float layers = float(p_layers);

  for (int i = 0; i < 12; i++) {
    if (i >= p_layers) break;
    float fi = float(i);
    // 0 = far away, 1 = passing the camera.
    float depth = fract(fi / layers + t);
    float fade = smoothstep(0.0, 0.25, depth) * smoothstep(1.0, 0.85, depth);
    float scale = mix(14.0, 1.2, depth);

    vec2 q = p * rot(p_swirl * (depth * 1.5 + fi * 0.4) + u_time * 0.03 * p_swirl);
    q = q * scale + fi * 19.19;
    vec2 cell = floor(q);
    vec2 f = fract(q) - 0.5;

    vec3 rnd = hash32(cell + fi * 7.31);
    if (rnd.z > p_density) continue;

    // Particles stay clear of the cell border so their glow is never cut off by it.
    vec2 offset = (rnd.xy - 0.5) * 0.5;
    float d = length(f - offset);
    float band = spectrumAt(rnd.x * 0.9) * p_react;
    float radius = p_size * 0.028 * (0.35 + 1.6 * band + 0.5 * u_kick * p_react);
    // Hot centre with a soft skirt that reaches zero at a quarter of the cell.
    float g = radius * radius / (d * d + radius * radius * 0.08);
    g = min(g, 14.0) * smoothstep(0.25, 0.03, d);
    col += paletteAt(rnd.y + depth * 0.35 + u_time * 0.02) * g * fade * (0.25 + 1.3 * band);
  }

  // Faint dust so the field never goes completely black.
  col += paletteAt(0.6) * 0.006 * u_level * p_react;
  fragColor = vec4(col, 1.0);
}
