// Tunnel: a polar fly-through whose walls carry the recent spectrum.
#include <math>
#include <color>

uniform float p_speed;
uniform float p_sides;
uniform float p_twist;
uniform float p_rings;
uniform float p_segments;
uniform int p_pattern;
uniform float p_glow;
uniform float p_react;

/** Soft-edged band around zero. `w` is the half width, `aa` the pixel footprint. */
float band(float d, float w, float aa) {
  return smoothstep(w + aa, w - aa, abs(d));
}

void main() {
  vec2 p = centered(v_uv);
  // A slow camera drift keeps the vanishing point alive.
  p += 0.035 * vec2(sin(u_time * 0.31), cos(u_time * 0.23));

  float a = atan(p.y, p.x);
  float r = length(p);

  // Morph the cross-section from a circle into a polygon.
  float n = max(p_sides, 3.0);
  float seg = TAU / n;
  float local = mod(a + u_time * 0.07 + seg * 0.5, seg) - seg * 0.5;
  float rr = mix(r, r * cos(local) / cos(seg * 0.5), smoothstep(2.0, 3.0, p_sides));
  // Kicks shove the walls towards the viewer.
  rr *= 1.0 + 0.18 * u_kick * p_react;
  rr = max(rr, 1e-3);

  float depth = 0.3 / rr;
  float z = depth + u_audioTime * p_speed;
  float ang = a / TAU + p_twist * 0.08 * depth;

  // Every ring shows the spectrum that was playing when it left the camera.
  float mirrored = abs(fract(ang * 2.0) * 2.0 - 1.0);
  float s = historyAt(mirrored * 0.85, depth * 0.06) * p_react;

  vec2 tuv = vec2(ang * p_segments, z * p_rings);
  vec2 cell = floor(tuv);
  vec2 f = fract(tuv);
  // Distance to the nearest cell border, in cells.
  vec2 edge = 0.5 - abs(f - 0.5);

  // Analytic pixel footprint in pattern space (fwidth would break on the atan seam).
  float px = 1.0 / u_resolution.y;
  vec2 w = vec2(p_segments * px / (TAU * max(r, 1e-3)), p_rings * 0.3 * px / (rr * rr));
  // Detail that has become smaller than a pixel fades out instead of shimmering.
  float detail = 1.0 / (1.0 + 5.0 * max(w.x, w.y));

  float v = 0.0;
  if (p_pattern == 0) {
    // Grid: thin bright lines that swell with the energy of their ring.
    float lw = 0.012 + 0.05 * s;
    v = max(band(edge.x, lw, w.x), band(edge.y, lw * 1.6, w.y));
    // A faint fill so the cells read as panels.
    v += 0.06 * s;
  } else if (p_pattern == 1) {
    // Rings.
    v = band(f.y - 0.5, 0.1 + 0.3 * s, w.y);
  } else if (p_pattern == 2) {
    // Checkerboard.
    vec2 e = smoothstep(vec2(0.0), w * 1.5, edge);
    v = mod(cell.x + cell.y, 2.0) * e.x * e.y * (0.35 + 0.9 * s);
  } else if (p_pattern == 3) {
    // Panels: every cell listens to its own frequency.
    vec2 rnd = hash22(cell);
    float level = spectrumAt(rnd.x * 0.85) * p_react;
    vec2 e = smoothstep(vec2(0.05), vec2(0.05) + w * 1.5, edge);
    v = smoothstep(0.45, 0.95, level + rnd.y * 0.3) * e.x * e.y;
  } else {
    // Image-mapped walls, falling back to rings without an image.
    if (u_imageAspect > 0.0) {
      vec3 img = texture(u_image, vec2(fract(ang * 2.0), fract(z * 0.35))).rgb;
      float fogI = smoothstep(0.02, 0.35, rr);
      fragColor = vec4(img * (0.7 + 1.5 * s) * fogI, 1.0);
      return;
    }
    v = band(f.y - 0.5, 0.3, w.y);
  }
  v *= detail;

  // The palette mirrors with a period of 2, so ang * 2 is continuous across the atan seam.
  vec3 base = paletteAt(z * 0.06 + ang * 2.0 + s * 0.25);
  vec3 col = base * v * (0.45 + 1.1 * s);

  // A ring of light leaves the camera on every beat and races down the tunnel.
  float travel = depth * 0.22 - u_beatPhase;
  float ring = exp(-travel * travel * 60.0) * step(0.0, travel + 0.3);
  col += base * v * ring * 1.4 * p_react;

  // Far rings fade into the dark centre.
  col *= smoothstep(0.02, 0.35, rr);

  // Core glow pumping with the low end.
  float core = exp(-r * r * 38.0);
  col += paletteAt(u_time * 0.03 + 0.5) * core * p_glow *
         (0.12 + (1.4 * u_kick + 0.5 * u_bass) * p_react);

  fragColor = vec4(col, 1.0);
}
