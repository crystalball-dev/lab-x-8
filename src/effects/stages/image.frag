// Image: the user's picture. On top of the visuals it keeps its own colours and stays sharp; in
// the scene it is mixed in before the effects. Either way the audio pulses, lights and bends it.
//
// Every image layer draws with this shader, only inside the part of the screen it can reach.
// imageReach() in src/gfx/imageReach.ts works that out from the same numbers as below: how far
// each effect can move the picture, and how far the glow and shadow spread. Change them together.
#include <math>
#include <color>

uniform sampler2D u_input;
/** Width over height of this layer's picture, which the renderer binds as u_image. */
uniform float u_layerAspect;
uniform int p_blend;
uniform float p_opacity;
uniform int p_fit;
uniform float p_scale;
uniform float p_x;
uniform float p_y;
uniform float p_rotate;
uniform int p_kaleido;
uniform float p_brightness;
uniform float p_glow;
uniform float p_shadow;
uniform float p_glitch;
uniform float p_split;
uniform float p_warp;
uniform float p_ripple;
uniform float p_displace;

/** Size of the picture on screen at scale 1, in centred units: the screen is 1 high. */
vec2 fittedSize() {
  float ia = u_layerAspect;
  float sa = u_aspect;
  if (p_fit == 0) return vec2(ia, 1.0) * (ia > sa ? 1.0 : sa / ia);   // cover
  if (p_fit == 1) return vec2(ia, 1.0) * (ia > sa ? sa / ia : 1.0);   // contain
  if (p_fit == 2) return vec2(sa, 1.0);                               // stretch
  return vec2(ia, 1.0) * 0.5;                                          // tile
}

/**
 * How much of the picture a texel of the premultiplied texture shows with the current blend:
 * black vanishes in Screen and Add, white in Multiply, and transparency everywhere.
 */
float presence(vec4 texel) {
  float bright = max(max(texel.r, texel.g), texel.b);
  if (p_blend == 1 || p_blend == 2) return bright;
  if (p_blend == 3) return texel.a - bright;
  return texel.a;
}

/**
 * The picture's outline blurred over `radius` screen units: a coarse mip level, read four times
 * on a rotated grid to hide its texels, faded with the distance outside the picture's frame.
 */
float blurredShape(vec2 uv, vec2 frame, float radius) {
  vec2 texels = vec2(textureSize(u_image, 0));
  float lod = log2(max(radius / frame.y * texels.y, 1.0));
  vec2 offset = exp2(lod) / texels;
  vec2 inside = p_fit == 3 ? uv : clamp(uv, 0.0, 1.0);
  float shape = presence(textureLod(u_image, inside + offset * vec2(0.25, 0.75), lod)) +
                presence(textureLod(u_image, inside + offset * vec2(-0.75, 0.25), lod)) +
                presence(textureLod(u_image, inside + offset * vec2(-0.25, -0.75), lod)) +
                presence(textureLod(u_image, inside + offset * vec2(0.75, -0.25), lod));
  float outside = length((uv - inside) * frame);
  return shape * 0.25 * exp(-outside / radius);
}

void main() {
  vec3 scene = texture(u_input, v_uv).rgb;
  vec2 frame = fittedSize() * max(p_scale, 1e-3);
  vec2 p = centered(v_uv) - vec2(p_x * 0.5 * u_aspect, p_y * 0.5);

  p *= rot(p_rotate * u_audioTime * 0.1);
  if (p_kaleido > 0) p = kaleido(p, float(p_kaleido)).yx;

  // Flowing noise displacement.
  vec2 n = vnoise2(p * 2.5 + vec2(0.0, u_audioTime * 0.15)) - 0.5;
  p += n * p_warp * 0.3;

  // Rings of past bass travel outwards from the picture's centre.
  float wave = historyAt(0.08, length(p) * 1.1) - 0.35;
  p += normalize(p + 1e-5) * wave * p_ripple * 0.12;

  // The visuals behind push the picture around, at most as far as very bright light would.
  p += clamp(scene.rg - scene.gb, -4.0, 4.0) * p_displace * 0.08;

  // Drum hits tear bands of the picture sideways. The bands re-roll 15 times a second.
  float tq = floor(u_time * 15.0);
  float band = floor(v_uv.y * 28.0 + hash11(tq) * 28.0);
  float torn = step(1.0 - 0.8 * p_glitch * u_onset, hash12(vec2(band, tq)));
  p.x += (hash12(vec2(band, tq + 4.0)) - 0.5) * 0.12 * torn;

  vec2 uv = p / frame + 0.5;
  vec2 fw = max(fwidth(uv), vec2(1e-6));
  vec2 edge = smoothstep(vec2(0.0), fw, uv) * smoothstep(vec2(0.0), fw, 1.0 - uv);
  float coverage = p_fit == 3 ? 1.0 : edge.x * edge.y;

  // Colour planes slip apart, further on torn bands. Each plane brings its own transparency,
  // so the edges of a logo fringe in colour.
  vec2 d = vec2(p_split * (1.0 + 3.0 * torn), 0.0);
  vec4 r = imageAt(uv + d);
  vec4 g = imageAt(uv);
  vec4 b = imageAt(uv - d);
  vec3 img = vec3(r.r, g.g, b.b) * p_brightness;
  vec3 a = vec3(r.a, g.a, b.a) * (p_opacity * coverage);

  // Where an opaque picture covers the visuals, nothing behind it shows: not even its shadow.
  if (p_blend == 0 && min(a.r, min(a.g, a.b)) >= 1.0) {
    fragColor = vec4(img, 1.0);
    return;
  }

  // Lift the picture off the visuals: a shadow that backs every part of it, so even thin
  // lettering reads over a busy picture, then a rim of neon in the palette's colours. Beyond
  // 0.12 of the screen height outside the picture the rim adds less than 1/10000, so it is not
  // read there, and neither shape is read when both are off.
  float outside = p_fit == 3 ? 0.0 : length((uv - clamp(uv, 0.0, 1.0)) * frame);
  float near = p_glow > 0.0 && outside < 0.12 ? blurredShape(uv, frame, 0.012) : 0.0;
  float far = p_glow > 0.0 || p_shadow > 0.0 ? blurredShape(uv, frame, 0.045) : 0.0;
  // The visuals are HDR here, often several times brighter than white, so halving them would
  // barely show after tone mapping. Bright light is pulled down harder than dim light.
  float shade = p_shadow * sat(far * 2.5) * p_opacity * 0.9;
  float peak = max(max(scene.r, scene.g), scene.b);
  scene *= (1.0 - shade) / (1.0 + shade * peak);
  vec3 neon = paletteAt(atan(p.y, p.x + 1e-6) / 3.14159265 + u_audioTime * 0.05);
  scene += neon * (near * 1.8 + far * 0.3) * p_glow * p_opacity;

  vec3 col;
  if (p_blend == 0) {
    col = mix(scene, img, a);                                        // normal
  } else if (p_blend == 1) {
    vec3 s = img * a;                                                // screen
    vec3 hi = max(scene, s);
    col = hi + min(scene, s) * (1.0 - clamp(hi, 0.0, 1.0));
  } else if (p_blend == 2) {
    col = scene + img * a;                                           // add
  } else if (p_blend == 3) {
    col = scene * mix(vec3(1.0), img * 2.0, a);                      // multiply
  } else if (p_blend == 4) {
    col = abs(scene - img * a);                                      // difference
  } else {
    col = scene * mix(vec3(1.0), vec3(luma(img) * 2.0), a);          // mask: the picture reveals the visuals
  }
  fragColor = vec4(col, 1.0);
}
