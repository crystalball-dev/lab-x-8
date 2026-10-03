// Transition: blends the finished picture of the look fading out with the look fading in.
// Both arrive display ready, tone mapped and encoded, so this mixes like a video mixer does.
// The styles follow TRANSITION_STYLES in params/schema.ts.
#include <math>
#include <color>

uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform int u_style;

void main() {
  float t = clamp(u_progress, 0.0, 1.0);
  float eased = t * t * (3.0 - 2.0 * t);
  vec3 a = texture(u_from, v_uv).rgb;
  vec3 b = texture(u_to, v_uv).rgb;
  vec3 col;

  if (u_style == 0) {
    // Crossfade.
    col = mix(a, b, eased);
  } else if (u_style == 1) {
    // Screen: one look dims as the other comes up, and their light adds up in between.
    vec3 fa = a * (1.0 - eased);
    vec3 fb = b * eased;
    col = 1.0 - (1.0 - fa) * (1.0 - fb);
  } else if (u_style == 2) {
    // Brightest first: the new look breaks through where it shines most, then fills the dark.
    float threshold = 1.0 - t * 1.3;
    col = mix(a, b, smoothstep(threshold, threshold + 0.3, luma(b)));
  } else {
    // Glitch blocks: the picture flips block by block in random order, tearing as each flips.
    vec2 cell = floor(v_uv * vec2(9.0 * u_aspect, 9.0));
    float flip = hash12(cell) * 0.9 + 0.05;
    float near = smoothstep(0.08, 0.0, abs(t - flip));
    vec2 uv = v_uv + vec2((hash12(cell + 7.3) - 0.5) * 0.08 * near, 0.0);
    float split = 0.006 * near;
    col = t < flip
      ? texture(u_from, uv).rgb
      : vec3(
          texture(u_to, uv + vec2(split, 0.0)).r,
          texture(u_to, uv).g,
          texture(u_to, uv - vec2(split, 0.0)).b);
  }
  fragColor = vec4(col, 1.0);
}
