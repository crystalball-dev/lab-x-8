// Feedback: video feedback loop. The previous frame is transformed, decayed and mixed back in.
// All rates are expressed per 60 Hz frame and scaled by the real frame time, so the look is
// the same at 60, 165 or an exported 30 frames per second.
#include <math>
#include <color>

uniform sampler2D u_input;
uniform sampler2D u_feedback;
uniform float p_amount;
uniform float p_zoom;
uniform float p_rotate;
uniform float p_shiftX;
uniform float p_shiftY;
uniform float p_warp;
uniform float p_hue;
uniform float p_blur;
uniform int p_mode;

void main() {
  float steps = clamp(u_dt * 60.0, 0.0, 4.0);
  vec2 p = centered(v_uv);
  p *= 1.0 - p_zoom * steps;
  p *= rot(p_rotate * steps);
  p += vec2(p_shiftX, p_shiftY) * steps;
  vec2 n = vnoise2(p * 3.0 + u_time * 0.1) - 0.5;
  p += n * p_warp * 0.02 * steps;
  vec2 uv = p / vec2(u_aspect, 1.0) + 0.5;

  vec2 o = p_blur * 2.0 / u_resolution;
  vec3 fb = texture(u_feedback, uv).rgb * 0.4 +
            (texture(u_feedback, uv + vec2(o.x, o.y)).rgb +
             texture(u_feedback, uv + vec2(-o.x, o.y)).rgb +
             texture(u_feedback, uv + vec2(o.x, -o.y)).rgb +
             texture(u_feedback, uv + vec2(-o.x, -o.y)).rgb) * 0.15;

  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  fb *= inside.x * inside.y;
  fb = max(hueRotate(fb, p_hue * steps), 0.0);
  float decay = pow(p_amount, steps);
  // The small subtraction clears the dim haze that a pure multiply would leave behind forever.
  fb = max(fb * decay - (1.0 - decay) * 0.05, 0.0);
  // A single bad pixel would circulate forever, so sanitize before mixing.
  if (any(isnan(fb)) || any(isinf(fb))) fb = vec3(0.0);
  // Limiter: light above full brightness is compressed, so a loop with gain settles
  // instead of climbing forever.
  fb /= 1.0 + max(luma(fb) - 1.0, 0.0);

  vec3 cur = texture(u_input, v_uv).rgb;
  vec3 col;
  if (p_mode == 0) {
    // Trails: whichever is brighter wins the whole pixel. Taking the maximum per channel
    // would merge different hues and drift towards white.
    col = mix(fb, cur, smoothstep(-0.04, 0.04, luma(cur) - luma(fb)));
  } else if (p_mode == 1) {
    col = cur + fb;                                              // additive build-up
  } else if (p_mode == 2) {
    vec3 hi = max(cur, fb);                                      // screen
    col = hi + min(cur, fb) * (1.0 - clamp(hi, 0.0, 1.0));
  } else {
    col = mix(cur, fb / max(pow(p_amount, steps), 1e-3), p_amount); // ghosting
  }
  fragColor = vec4(min(col, vec3(8.0)), 1.0);
}
