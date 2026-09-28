// Moire: interference of circular waves from drifting emitters.
#include <math>

uniform int p_sources;
uniform float p_frequency;
uniform float p_speed;
uniform float p_sharpness;
uniform float p_drift;
uniform float p_react;

void main() {
  vec2 p = centered(v_uv);
  float t = u_audioTime * p_speed;
  float sum = 0.0;
  int n = max(p_sources, 1);

  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float fi = float(i);
    vec2 c = 0.45 * p_drift * vec2(u_aspect * 0.8, 1.0) *
             vec2(sin(t * 0.13 * (1.0 + fi * 0.37) + fi * 2.4),
                  cos(t * 0.11 * (1.0 + fi * 0.29) + fi * 1.3));
    float band = spectrumAt(0.05 + fi * 0.14) * p_react;
    float d = length(p - c);
    sum += sin(d * p_frequency * (1.0 + 0.12 * band) - t * 2.0 + fi * 1.9) * (0.6 + 0.8 * band);
  }
  float v = sum / float(n);

  // Quantize the field into hard bands. The edge width follows the pixel footprint.
  float field = v * PI * 2.0;
  float soft = mix(1.0, 0.0, p_sharpness) + fwidth(field) * 1.5;
  float bands = smoothstep(-soft, soft, sin(field));

  vec3 col = paletteAt(v * 0.6 + 0.5 + u_time * 0.02) * bands;
  col += paletteAt(v * 0.6 + 0.85) * (1.0 - bands) * 0.12;
  col *= 0.45 + 0.9 * u_level * p_react + 0.8 * u_kick * p_react;
  fragColor = vec4(col, 1.0);
}
