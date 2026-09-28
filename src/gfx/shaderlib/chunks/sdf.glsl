// --- sdf: 2D signed distance functions ------------------------------------------------------------

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdTriangle(vec2 p, float r) {
  const float k = 1.73205080757;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float sdHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.86602540378, 0.5, 0.57735026919);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

/** Regular polygon with n sides, circumradius r. n may be fractional for morphing. */
float sdPolygon(vec2 p, float r, float n) {
  float seg = 6.28318530718 / n;
  float a = atan(p.x, p.y);
  a = mod(a + seg * 0.5, seg) - seg * 0.5;
  return cos(a) * length(p) - r * cos(seg * 0.5);
}

/**
 * A neon line: a crisp core of the given width plus a faint halo.
 * The halo dies out quickly, so many overlapping lines still leave the background black.
 */
float glowLine(float d, float width) {
  float x = abs(d) / max(width, 1e-5);
  return exp(-x * x) + 0.2 * exp(-x * 0.4);
}
