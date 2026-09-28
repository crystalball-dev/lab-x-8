// Bloom upsample: 3x3 tent filter, blended with the sharper level it lands on.

uniform sampler2D u_input;   // the blurrier, lower resolution level
uniform sampler2D u_inputB;  // the level at this resolution
uniform vec2 u_texel;
uniform float u_radius;

void main() {
  vec2 t = u_texel;
  vec3 s = texture(u_input, v_uv).rgb * 4.0;
  s += (texture(u_input, v_uv + vec2(t.x, 0.0)).rgb +
        texture(u_input, v_uv - vec2(t.x, 0.0)).rgb +
        texture(u_input, v_uv + vec2(0.0, t.y)).rgb +
        texture(u_input, v_uv - vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(u_input, v_uv + t).rgb +
       texture(u_input, v_uv - t).rgb +
       texture(u_input, v_uv + vec2(t.x, -t.y)).rgb +
       texture(u_input, v_uv + vec2(-t.x, t.y)).rgb;
  s /= 16.0;
  fragColor = vec4(mix(texture(u_inputB, v_uv).rgb, s, u_radius), 1.0);
}
