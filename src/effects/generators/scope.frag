// Scope: vector-monitor traces. A plain oscilloscope, a circular one, and spectrum ridgelines.
#include <math>
#include <sdf>

uniform int p_mode;
uniform int p_lines;
uniform float p_amplitude;
uniform float p_thickness;
uniform float p_react;

/** Waveform with the finest detail averaged out, like the limited bandwidth of a real scope. */
float wave(float x) {
  float e = 1.0 / 512.0;
  return 0.25 * waveformAt(x - e) + 0.5 * waveformAt(x) + 0.25 * waveformAt(x + e);
}

vec3 trace(vec2 p) {
  float x = v_uv.x;
  float e = 2.0 / u_resolution.x;
  // Pin the ends of the trace so it enters and leaves the screen on the centre line.
  float env = pow(sat(sin(x * PI)), 0.35);
  float amp = p_amplitude * env * (0.6 + 0.6 * p_react);
  float y = wave(x) * amp;
  // Distance to a curve needs the slope, otherwise steep sections look thin.
  float slope = (wave(x + e) - wave(x - e)) * amp / (2.0 * e * u_aspect);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float spread = 1.0 + fi * 0.45;
    float stretch = sqrt(1.0 + slope * slope * spread * spread);
    float d = (p.y - y * spread) / stretch;
    float w = p_thickness * (1.0 + fi * 1.5);
    // The beam dims where it moves fast, as on a real tube.
    float beam = 1.0 / sqrt(stretch);
    col += paletteAt(0.1 + fi * 0.22 + x * 0.35 + u_time * 0.03) * glowLine(d, w) * beam /
           (1.0 + fi * 1.6);
  }
  return col * (0.8 + 0.9 * u_level * p_react);
}

vec3 circle(vec2 p) {
  float r = length(p);
  float a = fract(atan(p.y, p.x) / TAU + 0.25);
  float base = 0.22 * (1.0 + 0.15 * u_kick * p_react);
  // Fade the waveform out where it wraps around, so the ring closes cleanly.
  float seam = smoothstep(0.0, 0.05, a) * smoothstep(1.0, 0.95, a);
  float wv = wave(a) * seam;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float ringR = base * (1.0 + fi * 0.33) + wv * p_amplitude * 0.3 * (0.6 + 0.6 * p_react);
    float w = p_thickness * (1.0 + fi);
    // a * 2 keeps the mirrored palette continuous across the wrap.
    col += paletteAt(0.2 + fi * 0.2 + a * 2.0 + u_time * 0.03) * glowLine(r - ringR, w) /
           (1.0 + fi);
  }
  return col * (0.8 + 0.9 * u_level * p_react);
}

vec3 ridges(vec2 p, float px) {
  vec3 col = vec3(0.0);
  int n = max(p_lines, 2);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    // Painted back to front: 0 is the oldest ridge at the top.
    float k = float(i) / float(n - 1);
    float persp = mix(0.5, 1.0, k);
    float xx = p.x / (persp * u_aspect * 0.46);
    if (abs(xx) > 1.0) continue;
    float age = (1.0 - k) * 0.92;
    float h = historyAt(abs(xx) * 0.8, age) * p_react;
    float env = smoothstep(1.0, 0.55, abs(xx));
    float y = mix(0.36, -0.42, k) + h * p_amplitude * 0.5 * env * persp;
    float d = p.y - y;
    // Nearer ridges hide whatever lies behind and below them.
    col *= smoothstep(-px, px, d);
    col += paletteAt(k * 0.55 + h * 0.45 + u_time * 0.02) *
           glowLine(d, p_thickness * persp) * (0.3 + 1.7 * h) * (0.35 + 0.65 * k);
  }
  return col;
}

void main() {
  vec2 p = centered(v_uv);
  float px = 1.0 / u_resolution.y;
  vec3 col;
  if (p_mode == 0) col = trace(p);
  else if (p_mode == 1) col = circle(p);
  else col = ridges(p, px);
  fragColor = vec4(col, 1.0);
}
