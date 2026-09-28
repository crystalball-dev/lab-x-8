// Image: brings the user image into the scene and bends it with the audio.
#include <math>
#include <color>

uniform sampler2D u_input;
uniform float p_opacity;
uniform int p_blend;
uniform int p_fit;
uniform float p_scale;
uniform float p_warp;
uniform float p_ripple;
uniform float p_split;
uniform float p_displace;
uniform float p_rotate;
uniform int p_kaleido;
uniform float p_brightness;

/** Maps centred screen coordinates to image UVs. Returns coverage in z. */
vec3 imageUv(vec2 p) {
  float ia = u_imageAspect;
  float sa = u_aspect;
  vec2 q = p / max(p_scale, 1e-3);
  vec2 uv;
  float coverage = 1.0;
  if (p_fit == 0) {
    float h = ia > sa ? 1.0 : sa / ia;       // cover
    uv = q / vec2(h * ia, h) + 0.5;
  } else if (p_fit == 1) {
    float h = ia > sa ? sa / ia : 1.0;       // contain
    uv = q / vec2(h * ia, h) + 0.5;
    vec2 edge = smoothstep(vec2(0.0), vec2(0.004), uv) * smoothstep(vec2(0.0), vec2(0.004), 1.0 - uv);
    coverage = edge.x * edge.y;
  } else if (p_fit == 2) {
    uv = q / vec2(sa, 1.0) + 0.5;            // stretch
  } else {
    uv = q / vec2(0.5 * ia, 0.5) + 0.5;      // tile
  }
  return vec3(uv, coverage);
}

void main() {
  vec3 gen = texture(u_input, v_uv).rgb;
  vec2 p = centered(v_uv);

  p *= rot(p_rotate * u_audioTime * 0.1);
  if (p_kaleido > 0) p = kaleido(p, float(p_kaleido)).yx;

  // Flowing noise displacement.
  vec2 n = vnoise2(p * 2.5 + vec2(0.0, u_audioTime * 0.15)) - 0.5;
  p += n * p_warp * 0.3;

  // Rings of past bass travelling outwards.
  float r = length(p);
  float wave = historyAt(0.08, r * 1.1) - 0.35;
  p += normalize(p + 1e-5) * wave * p_ripple * 0.12;

  // The generated pattern bends the picture.
  p += (gen.rg - gen.gb) * p_displace * 0.08;

  vec3 m = imageUv(p);
  vec2 d = vec2(p_split, 0.0);
  vec3 img = vec3(
    texture(u_image, m.xy + d).r,
    texture(u_image, m.xy).g,
    texture(u_image, m.xy - d).b) * p_brightness;
  float a = p_opacity * m.z;

  vec3 col;
  if (p_blend == 0) {
    col = img * a + gen;                                         // under: image is the base layer
  } else if (p_blend == 1) {
    col = mix(gen, img, a);                                      // over
  } else if (p_blend == 2) {
    col = gen + img * a;                                         // add
  } else if (p_blend == 3) {
    vec3 s = img * a;                                            // screen
    vec3 hi = max(gen, s);
    col = hi + min(gen, s) * (1.0 - clamp(hi, 0.0, 1.0));
  } else if (p_blend == 4) {
    col = gen * mix(vec3(1.0), img * 2.0, a);                    // multiply
  } else if (p_blend == 5) {
    col = abs(gen - img * a);                                    // difference
  } else {
    col = gen * mix(1.0, luma(img) * 2.0, a);                    // mask: image reveals the pattern
  }
  fragColor = vec4(col, 1.0);
}
