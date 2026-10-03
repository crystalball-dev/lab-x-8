// Glitch: digital signal corruption. Everything is derived from hashed time, never from a
// random number generator, so a render of the same track is repeatable frame for frame.
#include <math>
#include <color>

uniform sampler2D u_input;
uniform float p_amount;
uniform float p_rate;
uniform float p_slices;
uniform float p_blocks;
uniform float p_shift;
uniform float p_rgb;
uniform float p_tear;
uniform float p_mosaic;
uniform float p_crush;
uniform float p_streaks;

void main() {
  vec2 uv = v_uv;
  float a = p_amount;
  // The corruption pattern re-rolls `rate` times per second.
  float tq = floor(u_time * p_rate);

  // Horizontal slices at two scales slide sideways.
  float y1 = floor(uv.y * 9.0 + hash11(tq) * 9.0);
  float y2 = floor(uv.y * 41.0 + hash11(tq + 5.0) * 41.0);
  float on1 = step(1.0 - a * 0.6, hash12(vec2(y1, tq)));
  float on2 = step(1.0 - a * 0.4, hash12(vec2(y2, tq + 3.1)));
  float dx = (hash12(vec2(y1, tq + 7.7)) - 0.5) * on1 +
             (hash12(vec2(y2, tq + 9.3)) - 0.5) * on2 * 0.4;
  uv.x += dx * p_shift * p_slices;

  // Macroblocks jump to the wrong place, like a damaged video stream. Nine rows of square
  // blocks, so 16 by 9 on a wide picture, at any shape.
  float grid = 1.0 + floor(hash11(tq + 2.0) * 3.0);
  vec2 g = floor(uv * vec2(9.0 * u_aspect, 9.0) * grid);
  float onB = step(1.0 - a * 0.3 * p_blocks, hash12(g + tq * 0.31));
  uv += (hash22(g + tq) - 0.5) * 0.18 * onB * p_blocks;

  // A tear line wanders down the frame. Everything below it is sheared.
  float tearY = fract(hash11(floor(u_time * 1.7)) + u_time * 0.31);
  float below = smoothstep(tearY + 0.002, tearY - 0.002, uv.y);
  uv.x += below * p_tear * a * 0.12 * (hash11(tq + 13.0) - 0.5) * 2.0;

  // Mosaic: random blocks lose resolution.
  float cell = hash12(floor(v_uv * vec2(4.5 * u_aspect, 4.5)) + tq * 0.13);
  float onM = step(1.0 - a * p_mosaic, cell);
  float size = mix(1.0, 48.0, onM * p_mosaic) * u_resolution.y / 1080.0;
  if (size > 1.5) uv = (floor(uv * u_resolution / size) + 0.5) * size / u_resolution;

  uv = fract(uv);

  // Colour planes slip apart.
  float split = p_rgb * (0.35 + 0.65 * a + 0.5 * on1);
  vec3 col = vec3(
    texture(u_input, fract(uv + vec2(split, 0.0))).r,
    texture(u_input, uv).g,
    texture(u_input, fract(uv - vec2(split, 0.0))).b);

  // Bit crush.
  if (p_crush > 0.001) {
    float levels = mix(48.0, 2.5, p_crush * (0.4 + 0.6 * a));
    vec3 q = sqrt(max(col, 0.0));
    q = floor(q * levels + 0.5) / levels;
    col = q * q;
  }

  // Bright dashes where the signal drops out.
  float row = floor(v_uv.y * u_resolution.y / (2.0 * u_resolution.y / 1080.0));
  float pick = hash12(vec2(row, tq * 0.7 + 3.0));
  float start = hash12(vec2(row, tq + 21.0));
  float len = 0.05 + 0.3 * hash12(vec2(row, tq + 33.0));
  float dash = step(1.0 - 0.012 * a * p_streaks, pick) * step(start, v_uv.x) * step(v_uv.x, start + len);
  col += dash * (0.6 + 0.8 * hash12(vec2(row, tq + 40.0)));

  fragColor = vec4(col, 1.0);
}
