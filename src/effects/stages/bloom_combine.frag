// Bloom combine: adds the blurred highlights back onto the scene.

uniform sampler2D u_input;
uniform sampler2D u_inputB;  // bloom
uniform float p_intensity;

void main() {
  vec3 scene = texture(u_input, v_uv).rgb;
  vec3 bloom = texture(u_inputB, v_uv).rgb;
  fragColor = vec4(scene + bloom * p_intensity, 1.0);
}
