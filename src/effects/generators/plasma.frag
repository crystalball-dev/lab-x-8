// Plasma: domain-warped noise. The organic colour wash under everything else.
#include <math>
#include <color>

uniform float p_scale;
uniform float p_warp;
uniform float p_speed;
uniform float p_contours;
uniform float p_contrast;
uniform float p_react;

void main() {
  vec2 p = centered(v_uv) * p_scale;
  float t = u_audioTime * p_speed * 0.12;
  float punch = 1.0 + (0.6 * u_bass + 0.5 * u_kick) * p_react;

  // Two rounds of warping: noise bends the space that the next noise is read from.
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(
    fbm(p + p_warp * q + vec2(1.7, 9.2) + 0.7 * t),
    fbm(p + p_warp * q + vec2(8.3, 2.8) - 0.6 * t));
  float f = fbm(p + p_warp * punch * r);

  // Shape the field into glowing bodies and filaments separated by darkness.
  float body = smoothstep(0.38, 0.82, f);
  float ridge = pow(1.0 - abs(f * 2.0 - 1.0), 3.0);
  float shade = pow(sat(body + 0.45 * ridge), p_contrast);
  // One hue per place. Adding a second hue on top would wash the colours out to pastel.
  vec3 col = paletteAt(f * 1.6 + length(q) * 0.6 + u_time * 0.015) * shade * 1.5;
  // Dark veins follow the folds of the warp.
  col *= 0.25 + 0.75 * smoothstep(0.0, 0.12, abs(r.x - 0.5) + 0.04 * u_mid * p_react);

  if (p_contours > 0.5) {
    // Topographic contour lines, antialiased by the screen-space gradient.
    float v = f * p_contours;
    float d = abs(fract(v) - 0.5);
    float aa = fwidth(v) * 1.2;
    float line = smoothstep(0.5 - 0.08 - aa, 0.5 - 0.08 + aa, d);
    col = mix(col * 0.5, col * 2.4 + 0.04, line * (0.5 + 0.8 * u_high * p_react));
  }

  col *= 0.55 + 0.7 * u_level * p_react;
  fragColor = vec4(col, 1.0);
}
