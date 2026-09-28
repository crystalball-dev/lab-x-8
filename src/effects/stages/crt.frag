// CRT: the analog half of the look. Models the signal path of a worn composite monitor:
// sync instability, limited chroma bandwidth, the scanning beam, the phosphor mask and the tube.
// Runs at output resolution so scanlines and mask stay pixel exact.
#include <math>
#include <color>

uniform sampler2D u_input;
uniform float p_amount;
uniform float p_curvature;
uniform float p_scanlines;
uniform int p_pitch;
uniform bool p_interlace;
uniform float p_mask;
uniform int p_maskType;
uniform float p_bleed;
uniform float p_aberration;
uniform float p_ghost;
uniform float p_noise;
uniform float p_jitter;
uniform float p_wobble;
uniform float p_tracking;
uniform float p_roll;
uniform float p_flicker;
uniform float p_vignette;

vec2 curve(vec2 uv, float k) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + c.yx * c.yx * k;
  return c * 0.5 + 0.5;
}

vec3 stripes(float x) {
  const float dark = 0.2;
  float m = mod(floor(x), 3.0);
  return vec3(
    m < 0.5 ? 1.0 : dark,
    (m > 0.5 && m < 1.5) ? 1.0 : dark,
    m > 1.5 ? 1.0 : dark);
}

vec3 phosphorMask(vec2 fc) {
  if (p_maskType == 0) {
    // Aperture grille: continuous vertical stripes.
    return stripes(fc.x);
  }
  if (p_maskType == 1) {
    // Shadow mask: triads staggered every other row pair.
    float row = floor(fc.y / 2.0);
    return stripes(fc.x + mod(row, 2.0) * 1.5);
  }
  // Slot mask: stripes interrupted by staggered horizontal gaps.
  float column = floor(fc.x / 3.0);
  float gap = mod(floor(fc.y) + mod(column, 2.0) * 2.0, 4.0);
  return gap < 1.0 ? vec3(0.2) : stripes(fc.x);
}

void main() {
  float A = p_amount;
  // Noise and sync errors tick at 60 Hz whatever the frame rate, which keeps exports repeatable.
  float tq = floor(u_time * 60.0);
  vec2 uv = curve(v_uv, p_curvature * 0.2 * A);

  // Rounded tube outline.
  vec2 d = abs(uv * 2.0 - 1.0);
  float radius = 0.08 * p_curvature * A + 0.002;
  float outline = length(max(d - (1.0 - radius), 0.0)) - radius;
  float tube = smoothstep(0.0, -0.006, outline);

  float lines = u_outputSize.y / float(max(p_pitch, 1));
  float line = floor(uv.y * lines);

  // --- sync: the picture never sits perfectly still --------------------------------------------
  float wob = sin(uv.y * 7.0 + u_time * 2.3) * sin(uv.y * 2.7 - u_time * 1.1);
  float jit = (hash12(vec2(line, tq)) - 0.5) * step(0.6, hash12(vec2(line * 0.37, tq + 9.0)));
  float x = uv.x + wob * p_wobble * 0.015 * A + jit * p_jitter * 0.012 * A;

  // A tracking error band drifts down the picture, and the bottom edge tears like a tape head switch.
  float bandY = fract(0.15 - u_time * 0.045);
  float band = smoothstep(0.07, 0.0, abs(uv.y - bandY)) * p_tracking * A;
  float head = smoothstep(0.035, 0.0, uv.y) * p_tracking * A;
  x += band * (hash12(vec2(line, tq + 5.0)) - 0.5) * 0.12;
  x += head * (hash12(vec2(line, tq + 8.0)) - 0.3) * 0.06;
  vec2 suv = vec2(x, uv.y);

  // --- signal: colour travels through a narrower channel than brightness ---------------------
  vec2 px = 1.0 / u_resolution;
  vec2 dir = suv - 0.5;
  float ab = p_aberration * 0.012 * A;
  vec3 centre = vec3(
    texture(u_input, suv + dir * ab).r,
    texture(u_input, suv).g,
    texture(u_input, suv - dir * ab).b);
  vec3 yiq = rgb2yiq(centre);

  float spread = p_bleed * A * 5.0 * u_resolution.x / 1920.0;
  vec2 chroma = vec2(0.0);
  float total = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float w = exp(-fi * 0.4);
    chroma += rgb2yiq(texture(u_input, suv - vec2(fi * spread * px.x, 0.0)).rgb).yz * w;
    total += w;
  }
  yiq.yz = mix(yiq.yz, chroma / total, sat(p_bleed * A * 1.5));
  float soft = 0.5 * (
    rgb2yiq(texture(u_input, suv + vec2(px.x * 1.5, 0.0)).rgb).x +
    rgb2yiq(texture(u_input, suv - vec2(px.x * 1.5, 0.0)).rgb).x);
  yiq.x = mix(yiq.x, soft, 0.35 * p_bleed * A);
  vec3 col = max(yiq2rgb(yiq), 0.0);

  // Ghost: a weak echo of the signal arriving late.
  col += texture(u_input, suv - vec2(0.03, 0.0)).rgb * p_ghost * 0.22 * A;

  // --- beam: bright lines are fat, dim lines are thin ------------------------------------------
  float l = luma(col);
  float sy = uv.y * lines;
  if (p_interlace) sy = sy * 0.5 + mod(tq, 2.0) * 0.5;
  float beam = 0.5 + 0.5 * cos((fract(sy) - 0.5) * TAU);
  float scan = pow(beam, mix(1.8, 0.45, sat(l * 0.9)));
  col *= mix(1.0, scan * 1.5, p_scanlines * A);

  // --- phosphor mask -----------------------------------------------------------------------------
  float maskScale = max(1.0, floor(u_outputSize.y / 1080.0 + 0.5));
  vec3 mk = phosphorMask(gl_FragCoord.xy / maskScale);
  col *= mix(vec3(1.0), mk * 3.0 / (mk.r + mk.g + mk.b), p_mask * A);

  // --- noise -------------------------------------------------------------------------------------
  float fine = hash12(gl_FragCoord.xy + tq * 19.0) - 0.5;
  float coarse = hash12(floor(gl_FragCoord.xy * 0.5) + tq * 7.0) - 0.5;
  col += (fine * 0.6 + coarse * 0.4) * p_noise * A * 0.12;
  col += (band + head) * hash12(vec2(gl_FragCoord.x * 0.25, line) + tq) * 0.35;

  // --- tube --------------------------------------------------------------------------------------
  float hum = 0.5 + 0.5 * sin((uv.y * 1.3 + u_time * 0.21) * TAU);
  col *= 1.0 - p_roll * A * 0.4 * hum;
  col *= 1.0 - p_flicker * A * 0.18 * hash11(tq);
  vec2 vv = uv * (1.0 - uv);
  col *= mix(1.0, pow(sat(vv.x * vv.y * 16.0), 0.4), p_vignette * A);

  fragColor = vec4(max(col, 0.0) * tube, 1.0);
}
