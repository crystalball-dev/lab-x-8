// --- math: constants, rotation, hashing, noise ---------------------------------------------------

#define PI 3.14159265359
#define TAU 6.28318530718

float sat(float x) { return clamp(x, 0.0, 1.0); }

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Hashes without trigonometry (Dave Hoskins). Stable across GPU vendors.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

/** Smooth value noise read from the shared noise texture. One texture fetch. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(u_noise, (i + f + 0.5) / 256.0, 0.0).r;
}

/** Two independent noise channels in one fetch. */
vec2 vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(u_noise, (i + f + 0.5) / 256.0, 0.0).rg;
}

/** Fractal Brownian motion, 5 octaves, rotated between octaves to hide the lattice. */
float fbm(vec2 p) {
  const mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = m * p * 2.02 + 17.0;
    a *= 0.5;
  }
  return v / 0.96875;
}

/** Folds the plane into n mirrored wedges. */
vec2 kaleido(vec2 p, float n) {
  float seg = TAU / max(n, 1.0);
  float a = atan(p.y, p.x);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  return vec2(cos(a), sin(a)) * length(p);
}
