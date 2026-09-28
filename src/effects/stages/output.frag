// Output: tone mapping, sRGB encoding and dithering. The only pass that writes 8-bit colour.
#include <math>
#include <color>

uniform sampler2D u_input;
uniform int p_tonemap;
uniform float p_gain;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

/** Identity below the knee, then a smooth shoulder that approaches 1. */
float shoulder(float x) {
  const float k = 0.72;
  float t = max(x - k, 0.0);
  return min(x, k) + (1.0 - k) * t / (t + (1.0 - k));
}

void main() {
  vec3 c = max(texture(u_input, v_uv).rgb, 0.0) * p_gain;

  if (p_tonemap == 0) {
    // Vivid: compress by the brightest channel so neon colours keep their hue,
    // then let only the hottest highlights burn towards white.
    float peak = max(c.r, max(c.g, c.b));
    float mapped = shoulder(peak);
    c *= mapped / max(peak, 1e-4);
    c = mix(c, vec3(mapped), smoothstep(2.5, 9.0, peak) * 0.6);
  } else if (p_tonemap == 1) {
    c = aces(c);
  } else {
    c = min(c, 1.0);
  }

  c = linearToSrgb(c);
  // Triangular dither removes banding in dark gradients.
  vec2 fc = gl_FragCoord.xy + mod(u_frame, 64.0) * vec2(13.0, 7.0);
  c += (hash12(fc) + hash12(fc + 91.7) - 1.0) / 255.0;
  fragColor = vec4(c, 1.0);
}
