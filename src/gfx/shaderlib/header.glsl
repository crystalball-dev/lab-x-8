#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

// ---------------------------------------------------------------------------------------------
// Prepended to every fragment shader. Declares everything an effect can read without asking.
// ---------------------------------------------------------------------------------------------

layout(std140) uniform Globals {
  vec4 g_time;    // x: seconds, y: delta seconds, z: frame index, w: audio-warped seconds
  vec4 g_beat;    // x: beat phase 0..1, y: beat pulse, z: beat count, w: bpm
  vec4 g_hits;    // x: onset, y: kick, z: snare, w: hat (decaying impulses)
  vec4 g_misc;    // x: level, y: bar phase 0..1, z: newest history row, w: image aspect (0 = none)
  vec4 g_bandsA;  // smoothed bands: sub, bass, low mid, mid
  vec4 g_bandsB;  // smoothed bands: high mid, high, -, -
  vec4 g_fastA;   // fast bands: sub, bass, low mid, mid
  vec4 g_fastB;   // fast bands: high mid, high, -, -
  vec4 g_frame;   // xy: output size in pixels, z: output aspect, w: history scroll fraction
};

#define u_time           g_time.x
#define u_dt             g_time.y
#define u_frame          g_time.z
#define u_audioTime      g_time.w
#define u_beatPhase      g_beat.x
#define u_beatPulse      g_beat.y
#define u_beatCount      g_beat.z
#define u_bpm            g_beat.w
#define u_onset          g_hits.x
#define u_kick           g_hits.y
#define u_snare          g_hits.z
#define u_hat            g_hits.w
#define u_level          g_misc.x
#define u_barPhase       g_misc.y
#define u_imageAspect    g_misc.w
#define u_sub            g_bandsA.x
#define u_bass           g_bandsA.y
#define u_lowMid         g_bandsA.z
#define u_mid            g_bandsA.w
#define u_highMid        g_bandsB.x
#define u_high           g_bandsB.y
#define u_subFast        g_fastA.x
#define u_bassFast       g_fastA.y
#define u_lowMidFast     g_fastA.z
#define u_midFast        g_fastA.w
#define u_highMidFast    g_fastB.x
#define u_highFast       g_fastB.y
#define u_outputSize     g_frame.xy
#define u_aspect         g_frame.z

/** Size in pixels of the render target this pass draws into. */
uniform vec2 u_resolution;

uniform sampler2D u_spectrum;     // 1D, log-spaced magnitude 0..1, bass on the left
uniform sampler2D u_waveform;     // 1D, trigger-aligned waveform -1..1
uniform sampler2D u_spectrogram;  // 2D ring buffer of past spectra
uniform sampler2D u_noise;        // 256x256 tiling random RGBA
uniform sampler2D u_palette;      // 1D colour gradient
uniform sampler2D u_image;        // user image (valid when u_imageAspect > 0). Read it with imageAt()

in vec2 v_uv;
out vec4 fragColor;

/** Spectrum magnitude at x in 0..1 (0 = lowest frequency). */
float spectrumAt(float x) {
  return texture(u_spectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

/** Waveform sample at x in 0..1. */
float waveformAt(float x) {
  return texture(u_waveform, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

/** Past spectrum. age 0 = now, 1 = oldest stored row. Scrolls smoothly between rows. */
float historyAt(float x, float age) {
  float row = min(g_misc.z, g_misc.z + g_frame.w - clamp(age, 0.0, 0.97));
  return texture(u_spectrogram, vec2(clamp(x, 0.0, 1.0), row)).r;
}

/** Colour from the active palette. t wraps smoothly (mirrored). */
vec3 paletteAt(float t) {
  return texture(u_palette, vec2(t, 0.5)).rgb;
}

/** Aspect-corrected coordinates centred on the screen. y spans -0.5..0.5. */
vec2 centered(vec2 uv) {
  return (uv - 0.5) * vec2(u_aspect, 1.0);
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

/**
 * The user image at uv: linear colour and straight alpha. The texture holds premultiplied
 * sRGB, because only premultiplied colour filters cleanly at the edges of transparent pictures.
 */
vec4 imageAt(vec2 uv) {
  vec4 c = texture(u_image, uv);
  return vec4(srgbToLinear(c.rgb / max(c.a, 1e-4)), c.a);
}
