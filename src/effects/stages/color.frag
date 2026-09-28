// Color: grading in linear light.
#include <color>

uniform sampler2D u_input;
uniform float p_exposure;
uniform float p_contrast;
uniform float p_saturation;
uniform float p_hue;
uniform float p_paletteMap;
uniform float p_posterize;
uniform float p_invert;

void main() {
  vec3 c = texture(u_input, v_uv).rgb * p_exposure;

  // Re-colour by luminance through the active palette.
  float l = luma(c);
  vec3 mapped = paletteAt(clamp(l, 0.0, 1.0) * 0.92 + 0.04) * (0.25 + l);
  c = mix(c, mapped, p_paletteMap);

  c = max(hueRotate(c, p_hue), 0.0);
  c = max(mix(vec3(luma(c)), c, p_saturation), 0.0);
  // Contrast pivots on middle grey so highlights and shadows move apart evenly.
  c = pow(c / 0.18, vec3(p_contrast)) * 0.18;

  if (p_posterize > 0.001) {
    // Quantize in a perceptual space so the steps look evenly spaced.
    float levels = mix(20.0, 2.0, p_posterize);
    vec3 g = sqrt(c);
    g = floor(g * levels + 0.5) / levels;
    c = g * g;
  }

  c = mix(c, max(1.0 - c, 0.0), p_invert);
  fragColor = vec4(c, 1.0);
}
