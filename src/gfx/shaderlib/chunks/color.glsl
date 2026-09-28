// --- color: luminance, hue, colour spaces ---------------------------------------------------------

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/** Rotates hue by `turns` (1.0 = full circle) around the grey axis. Preserves luminance well. */
vec3 hueRotate(vec3 c, float turns) {
  float a = turns * 6.28318530718;
  vec3 k = vec3(0.57735026919);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

vec3 rgb2hsv(vec3 c) {
  vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
  return c.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
}

// NTSC luma / chroma separation, used for composite-video style colour bleed.
vec3 rgb2yiq(vec3 c) {
  return vec3(
    dot(c, vec3(0.299, 0.587, 0.114)),
    dot(c, vec3(0.5959, -0.2746, -0.3213)),
    dot(c, vec3(0.2115, -0.5227, 0.3112)));
}

vec3 yiq2rgb(vec3 c) {
  return vec3(
    dot(c, vec3(1.0, 0.956, 0.619)),
    dot(c, vec3(1.0, -0.272, -0.647)),
    dot(c, vec3(1.0, -1.106, 1.703)));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
