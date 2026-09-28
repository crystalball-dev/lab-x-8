// Layers: blends generator B over generator A.
#include <color>

uniform sampler2D u_input;
uniform sampler2D u_inputB;
uniform float p_mix;
uniform int p_blend;

void main() {
  vec3 a = texture(u_input, v_uv).rgb;
  vec3 b = texture(u_inputB, v_uv).rgb;
  // Layer B at its chosen strength.
  vec3 bm = b * p_mix;
  vec3 c;
  if (p_blend == 0) {
    c = mix(a, b, p_mix);                    // crossfade
  } else if (p_blend == 1) {
    c = a + bm;                              // add
  } else if (p_blend == 2) {
    vec3 hi = max(a, bm);                    // screen, safe above 1.0
    c = hi + min(a, bm) * (1.0 - clamp(hi, 0.0, 1.0));
  } else if (p_blend == 3) {
    c = mix(a, a * b * 2.0, p_mix);          // multiply
  } else if (p_blend == 4) {
    c = abs(a - bm);                         // difference
  } else {
    // Brighter wins: each pixel shows one layer or the other, so hues never mix to white.
    c = mix(a, bm, smoothstep(-0.04, 0.04, luma(bm) - luma(a)));
  }
  fragColor = vec4(c, 1.0);
}
