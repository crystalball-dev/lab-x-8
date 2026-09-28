// Bloom downsample: 13-tap filter that stays stable on thin bright lines.
// A threshold of zero or more turns the pass into the bright-pass prefilter.

uniform sampler2D u_input;
uniform vec2 u_texel;
uniform float u_threshold;
uniform float u_knee;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  soft = soft * soft / (4.0 * u_knee + 1e-4);
  return c * max(soft, br - u_threshold) / max(br, 1e-4);
}

/** Karis weight: tames single very bright pixels that would otherwise flicker. */
float weight(vec3 c) {
  return 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
}

void main() {
  vec2 t = u_texel;
  vec3 a = texture(u_input, v_uv + t * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(u_input, v_uv + t * vec2(0.0, 2.0)).rgb;
  vec3 c = texture(u_input, v_uv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(u_input, v_uv + t * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(u_input, v_uv).rgb;
  vec3 f = texture(u_input, v_uv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(u_input, v_uv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(u_input, v_uv + t * vec2(0.0, -2.0)).rgb;
  vec3 i = texture(u_input, v_uv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(u_input, v_uv + t * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(u_input, v_uv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(u_input, v_uv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(u_input, v_uv + t * vec2(1.0, -1.0)).rgb;

  vec3 col;
  if (u_threshold >= 0.0) {
    vec3 g0 = (a + b + d + e) * 0.25;
    vec3 g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25;
    vec3 g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    float w0 = weight(g0) * 0.125;
    float w1 = weight(g1) * 0.125;
    float w2 = weight(g2) * 0.125;
    float w3 = weight(g3) * 0.125;
    float w4 = weight(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    col = prefilter(max(col, 0.0));
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  fragColor = vec4(col, 1.0);
}
