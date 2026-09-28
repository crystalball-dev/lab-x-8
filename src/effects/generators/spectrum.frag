// Spectrum: the classic analyser, as radial bars, echo rings or mirrored bars.
#include <math>
#include <sdf>

uniform int p_mode;
uniform int p_bars;
uniform float p_radius;
uniform float p_height;
uniform float p_spin;
uniform float p_glow;
uniform float p_react;

vec3 radialBars(vec2 p, float px) {
  float r = length(p);
  float a = atan(p.y, p.x) / TAU + 0.25 + u_time * p_spin * 0.05;
  // Mirror so that the bass sits at the top and both halves match.
  float m = abs(fract(a) * 2.0 - 1.0);
  float n = float(p_bars);
  float idx = (floor(m * n) + 0.5) / n;
  float s = spectrumAt(idx * 0.85) * p_react;

  float inner = p_radius * (1.0 + 0.2 * u_kick * p_react);
  float top = inner + 0.004 + s * p_height;
  float body = smoothstep(inner - px, inner + px, r) * smoothstep(top + px, top - px, r);

  float fa = abs(fract(m * n) - 0.5);
  float fw = px * n / (PI * max(r, 1e-3));
  float bar = 1.0 - smoothstep(0.36 - fw, 0.36 + fw, fa);

  vec3 col = paletteAt(idx * 0.8 + u_time * 0.02) * body * bar * (0.5 + 1.7 * s);
  // Bright cap on every bar.
  col += paletteAt(idx * 0.8 + 0.2) * glowLine(r - top, 0.003) * bar * s * p_glow;

  // Waveform ring inside the bars.
  float ring = inner * 0.84 + waveformAt(fract(a)) * 0.04 * p_react;
  col += paletteAt(0.15 + u_time * 0.02) * glowLine(r - ring, 0.0025) * (0.7 + u_level) * p_glow;
  // The core flashes on kicks.
  col += paletteAt(0.5) * smoothstep(inner * 0.75, 0.0, r) * u_kick * p_react * 0.7;
  return col;
}

vec3 echoRings(vec2 p) {
  float r = length(p);
  float a = atan(p.y, p.x) / TAU + 0.25 + u_time * p_spin * 0.05;
  float m = abs(fract(a) * 2.0 - 1.0);
  float inner = p_radius * 0.5;
  float spacing = 0.035;
  float k0 = floor((r - inner) / spacing);
  vec3 col = vec3(0.0);
  // The displacement can push a ring across its neighbours, so test a few candidates.
  for (int j = -3; j <= 1; j++) {
    float k = k0 + float(j);
    if (k < 0.0 || k > 24.0) continue;
    float age = k / 25.0;
    float s = historyAt(m * 0.85, age) * p_react;
    float ringR = inner + k * spacing + s * p_height * 0.35;
    float fade = 1.0 - age;
    col += paletteAt(age * 0.9 + s * 0.3 + u_time * 0.02) *
           glowLine(r - ringR, 0.0022 + 0.002 * s) * (0.25 + 1.6 * s) * fade * p_glow;
  }
  col += paletteAt(0.5) * smoothstep(inner, 0.0, r) * u_kick * p_react * 0.7;
  return col;
}

vec3 mirroredBars(vec2 p, float px) {
  float halfWidth = u_aspect * 0.5;
  float m = abs(p.x) / halfWidth;
  float n = float(p_bars);
  float idx = (floor(m * n) + 0.5) / n;
  float s = spectrumAt(idx * 0.85) * p_react;
  float h = 0.004 + s * p_height;
  float y = abs(p.y);

  float fa = abs(fract(m * n) - 0.5);
  float fw = px * n / halfWidth;
  float bar = 1.0 - smoothstep(0.36 - fw, 0.36 + fw, fa);
  float body = smoothstep(h + px, h - px, y);

  vec3 col = paletteAt(idx * 0.8 + u_time * 0.02) * body * bar * (0.35 + 1.4 * s + 0.6 * y / max(h, 1e-3) * s);
  col += paletteAt(idx * 0.8 + 0.2) * glowLine(y - h, 0.003) * bar * s * p_glow;
  // Reflection line through the middle.
  col += paletteAt(0.1) * glowLine(p.y, 0.0015) * 0.35 * p_glow;
  return col;
}

void main() {
  vec2 p = centered(v_uv);
  float px = 1.0 / u_resolution.y;
  vec3 col;
  if (p_mode == 0) col = radialBars(p, px);
  else if (p_mode == 1) col = echoRings(p);
  else col = mirroredBars(p, px);
  fragColor = vec4(col, 1.0);
}
