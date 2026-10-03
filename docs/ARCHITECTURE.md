# Lab X-8 architecture

## Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript, strict mode |
| Rendering | WebGL2, fragment-shader pipeline in linear HDR (RGBA16F) |
| Audio | Web Audio, AudioWorklet tap, own FFT and analysis |
| Encoding | WebCodecs through Mediabunny, or FFmpeg through a local bridge |
| Desktop shell | Electron, packaged as a portable folder with electron-builder |
| Tooling | Vite, esbuild, Vitest |
| Runtime | The desktop application, or Chrome or Edge |

### Why this stack

The whole look is made of fullscreen shader passes, so the rendering cost sits on the GPU
whatever the host language is. That removes the usual reason to go native. What web
technology adds:

- Hardware video encoders (WebCodecs) with frames taken straight from the canvas, no readback.
- Audio capture from inputs and from the system without native code.
- A control panel that is ordinary HTML.
- No compiler toolchain and no engine. Node is needed to build, not to run.
- The same code runs as a desktop application and in a browser.

Alternatives considered:

| Option | Why not now |
| --- | --- |
| Rust with wgpu, or C++ with OpenGL | Best latency and direct device access, but a large toolchain and far more code for the same picture. Worth it only if native outputs become a requirement |
| Game engine (Unity, Godot, Unreal) | Heavy, editor-centred, and weak at frame-exact offline video with audio |
| TouchDesigner or similar | Node-based and licensed. The project asked for an owned codebase |
| Python with ModernGL | Quick to write, but garbage collection and the interpreter make frame pacing unreliable |

### What would change the recommendation

- **Spout or NDI output into other VJ software**: needs a native module in the desktop shell.
  Nothing in the renderer or the analysis would change.
- **Dedicated hardware without a browser engine**: a native port. The shaders are portable
  GLSL and the analysis is plain TypeScript with no browser dependencies, so both carry over.

OSC control needs no native code. It is a network listener in the shell's main process.
MIDI control needs nothing from the shell at all. Web MIDI is part of the browser engine and
would plug into the parameter store the same way the control panel does.

## Desktop shell

`electron/`, `bridge/`, `src/platform/`

The app does not know whether it runs in a browser or in the desktop application, with one
exception: `src/platform/desktop.ts` describes what it may ask of the shell, and is null in a
browser. Everything the shell provides sits behind that one interface.

```
 Lab X-8.exe
 ├─ main process (electron/main.ts)
 │    ├─ private server on 127.0.0.1, random port (electron/server.ts)
 │    │     ├─ serves the built app
 │    │     └─ hosts the export bridge (bridge/ExportBridge.ts) ──► FFmpeg, disk
 │    ├─ settings file (electron/settings.ts)
 │    ├─ permissions, system audio, save dialog
 │    └─ window
 └─ page process (the app, unchanged)
      └─ preload (electron/preload.ts): the DesktopApi, nothing else
```

### Why a private server

The app is loaded over HTTP from a server inside the shell, not from files. That keeps one
code path: the export bridge is the same module the development server hosts, reached through
the same requests and the same socket. It also gives the page a normal origin, which module
scripts, audio worklets and the encoders expect.

The server listens on the loopback interface only and picks a free port at every start.

### What the shell adds

| Feature | How |
| --- | --- |
| No throttling | Background throttling and window occlusion tracking are switched off at start |
| System audio | The display capture request is answered by the shell with the system's loopback audio, so no picker appears. Windows only |
| Fast GPU | The high performance graphics processor is requested on machines with two |
| FFmpeg | Looked for next to the program, then inside it, then on the `PATH` |
| Save dialog | The system dialog, opened by the main process |
| Settings | One JSON file. Browser storage is not used, because the port, and with it the origin, changes between starts |
| Portability | Data is kept next to the program when that folder is writable |

### Security

The page is treated as untrusted even though it is the app's own code.

| Measure | Effect |
| --- | --- |
| Context isolation, sandbox, no Node in the page | The page can reach only the functions of `DesktopApi` |
| Secret token | Generated at every start. The bridge refuses requests and sockets without it |
| Origin check | The bridge refuses requests that come from any other page |
| Approved paths | The bridge writes outside the exports folder only to a path the main process handed out from its own save dialog, and only once |
| Message sender check | The main process ignores messages from any frame that is not the app |
| Content security policy | Scripts, styles and connections from the app itself only. No `eval` |
| Permissions | Audio input, display capture and fullscreen. Everything else is denied, including the camera |
| Navigation | The window cannot leave the app or open other windows. Links to the publisher's website open in the system browser, nothing else does |
| File types | The bridge writes `.mp4`, `.mov`, `.webm` and `.mkv` only |

### Packaging

`npm run dist` runs `tools/dist.mjs`:

1. Builds the web app with Vite into `dist/`.
2. Bundles the shell with esbuild into `dist-electron/`. The `ws` library is bundled in, so
   the packaged app has no `node_modules`.
3. Copies the machine's FFmpeg and its licence into `vendor/ffmpeg/`.
4. Packages with electron-builder.
5. Moves the result into `release/Lab X-8/`, leaving `Lab X-8 Data/` and `Exports/`
   in place.

The folder names follow `productName` in `package.json`. The app reads the same name, with the
publisher and website, from `src/brand.ts`, and a unit test keeps the two in step.

The icon is drawn by `tools/make-icon.mjs` (`npm run icon`) from distance functions, one pass
per size, so the small sizes in the taskbar are drawn for their size rather than scaled down.

## Data flow

```
 audio source ──► tap worklet ──► HopBuffer ──► Analyzer ──► AudioFeatures
                                                                  │
 ParamStore ◄── modulation sources ◄── FrameClock ◄───────────────┤
     │                                     │                      │
     │                                 FrameState ◄───────────────┘
     ▼                                     ▼
 EffectPass (parameter uniforms)       Renderer ──► canvas ──► screen
                                                          └──► FrameSink ──► file
```

Two rules hold the design together:

1. **`AudioFeatures` is the only thing that crosses from audio to graphics.** The renderer
   never touches Web Audio. The analyzer never touches WebGL.
2. **Nothing on the render path reads a clock.** Time arrives in `FrameState`. Live playback
   feeds measured frame times, export feeds a fixed step. That is what makes export
   frame-exact.

## Audio

`src/audio`

### Capture

`AudioEngine` owns the Web Audio graph. Every source is connected to a tap worklet
(`worklet/tap.worklet.ts`) that mixes to mono and posts blocks of 256 samples to the main
thread. Tracks are also connected to the speakers. Live inputs are not.

### Analysis

`HopBuffer` turns the block stream into analysis windows at a fixed hop of about 10 ms,
independent of the frame rate. `Analyzer.processHop` then computes:

| Output | Method |
| --- | --- |
| Display spectrum | 2048-point FFT, Hann window, 256 log-spaced bins from 30 Hz to 16 kHz, 3.5 dB per octave tilt, attack and release smoothing |
| Six bands | Energy per band, automatic gain against the recent peak, dynamics expansion, per-band sensitivity, fast and smooth envelopes |
| Onsets | Spectral flux on log-compressed magnitudes in four ranges. Threshold from the median of the last second. Strength relative to the strongest recent hit |
| Waveform | Newest 1024 samples, aligned to a rising zero crossing so the trace holds still |
| Level | RMS with automatic gain |

Onset impulses are stored as a time and a strength and evaluated analytically when a frame
asks for them. They are therefore smooth at any frame rate.

The analyzer is a pure state machine. The same windows always give the same features. Live
playback and export use the same class.

### Beat clock

The tempo is a parameter, not a measurement. The beat and bar phase are a pure function of
the transport position:

```
beats = transport * bpm / 60 + offset
```

For tracks the transport is the position in the file, so beats stay put across loops and
seeks, and an export shows the same beats as the preview. For live inputs it is the stream
time, and tap tempo sets the offset.

## Rendering

`src/gfx`, `src/effects`

```
 generator A ─┐
 generator B ─┴─ layers ─ image* ─ feedback ─ glitch ─ colour ─ bloom ─ image* ─ CRT ─ output
                                      ▲      │        │                │
                                      └──────┴────────┴── history ◄────┘
```

\* The image stage runs at one of the two points, chosen by `image.placement`. In the scene,
every effect acts on the picture. On top, it is composited after bloom and outside the feedback
loop, so it keeps its own colours and only the CRT acts on it.

- Everything up to the image on top runs at scene resolution in linear HDR.
- CRT and output run at output resolution, so scanlines and the phosphor mask are pixel exact
  even when the scene is rendered at a lower scale.
- Colour grading sits after the glitch tap on purpose. Gain inside a feedback loop runs away
  to white.
- Stages whose amount is zero are skipped, not drawn at zero strength.
- All shaders are compiled at start, so switching patterns during a set never hitches.

### What a shader can read

`shaderlib/header.glsl` is prepended to every fragment shader. It declares:

| Kind | Names |
| --- | --- |
| Timing | `u_time`, `u_dt`, `u_frame`, `u_audioTime` |
| Beat | `u_beatPhase`, `u_beatPulse`, `u_beatCount`, `u_barPhase`, `u_bpm` |
| Hits | `u_onset`, `u_kick`, `u_snare`, `u_hat` |
| Bands | `u_sub`, `u_bass`, `u_lowMid`, `u_mid`, `u_highMid`, `u_high`, and `...Fast` variants |
| Level | `u_level` |
| Frame | `u_resolution`, `u_outputSize`, `u_aspect` |
| Functions | `spectrumAt(x)`, `waveformAt(x)`, `historyAt(x, age)`, `paletteAt(t)`, `centered(uv)`, `imageAt(uv)` |

These values live in one uniform block that is filled once per frame. Shared code is pulled in
with `#include <math>`, `<color>` or `<sdf>`.

The user image is stored premultiplied and still sRGB encoded, because only premultiplied colour
filters and mips cleanly at the edges of a transparent logo. Read it with `imageAt(uv)`, which
returns linear colour and straight alpha.

### Parameters in shaders

A uniform named `p_<key>` is bound to the parameter `<key>` of the effect. The `p_` prefix
keeps parameters apart from the engine's `u_` names, so a parameter can be called `noise` or
`time` without a clash.

## Parameters

`src/params`

Every tunable value is described by a `ParamDef`. From that one description follow:

- the control in the panel
- clamping and validation
- storage in presets
- the binding to a shader uniform
- whether and how the audio may drive it

`ParamStore.num(path)` returns the value after modulation. Modulation is applied once per
frame by `FrameClock`:

```
effective = clamp(value + depth * source * (max - min), min, max)
```

Groups flagged `preset: false` (tempo, audio input, display) describe the music or the
machine. Presets and Randomize leave them alone, and they cannot be modulated.

The image group is flagged `optional`: a preset changes it only if it stores image settings.
The built-in looks store none, so a logo stays where it was put while looks change. Saved
presets do store them, because a look can be built around the picture.

`upgradePreset` in `presets.ts` brings data from older versions up to date before it is
applied. Presets from before the image could be laid on top keep it in the scene, without the
newer glow, shadow and tearing, so they still look the way they did when they were saved.

## Export

`src/export`, `tools/exportBridge.ts`

`exportVideo` is a plain loop:

```
for each frame i:
    analyse the track up to the middle of frame i
    advance the clock by exactly 1 / fps
    let the look cycle change looks if a bar line is due
    render
    hand the canvas to the sink, wait until the sink is ready
```

The wait is the backpressure. A slow encoder slows the loop down. It never drops a frame.

| Sink | Path |
| --- | --- |
| `BrowserSink` | Canvas to `VideoFrame` to WebCodecs to MP4 or WebM, written to a picked file, to the bridge, or to memory |
| `FfmpegSink` | `readPixels` to WebSocket to FFmpeg standard input |

### Export bridge

`bridge/ExportBridge.ts` has no server of its own. A host hands it requests and socket
upgrades. There are two hosts: the desktop shell, and a Vite plugin (`tools/exportBridge.ts`)
for the development and preview servers.

Control goes over HTTP. Frames go over a WebSocket with a 64 MB sliding window: the sender
waits when that much data is unconfirmed. Memory use on both sides is constant for any export
length.

A file encoded in the page is written the same way. Containers patch their headers at the
end, so every chunk carries the file position it belongs to.

Two other transports were measured and rejected:

| Transport | Result |
| --- | --- |
| HTTP upload of typed arrays | 21 MB per second in an embedded browser. Under 3 frames per second at 1080p |
| HTTP upload of Blobs | Over 400 MB per second, but the browser's blob store filled up after about 1.8 GB and rejected further uploads |

The bridge accepts requests from its own page only. It writes into the exports folder, or to
a path the desktop shell approved. See [Security](#security).

### Repeatability

Every frame of an export receives identical inputs on every run. `tests/export.test.ts`
compares the complete frame state and every parameter value of two runs. Most patterns also
come out bit-identical. After a setting change, graphics drivers re-optimise shaders in the
background, and isolated pixels can then differ by one step out of 255 for a few frames.
Measured difference between two complete renders: 66 dB PSNR or better.

## Look cycle

`src/app/LookCycler.ts`, `src/gfx/TransitionPass.ts`

The cycle plays presets one after another and changes on bar lines. Which look plays is a pure
function of the position in the music: segment *k* of a track, the bars from *k* × *every* to
(*k* + 1) × *every*, always shows the same look of the pool, in order or in a shuffle dealt from
a seed. Random looks are rolled by `randomizeLook`, the function behind the Random button,
with a generator seeded from the shuffle number and *k*. Random overwrites every setting it
varies, so a random look does not depend on the looks before it, and seeking to a segment
rolls the same look as playing up to it. The transition into the next segment takes its last bars, so a new look has fully
arrived on the bar line.

During playback a transition starts when the position enters it, from whatever is on screen.
After a jump (a seek, the loop point of the demo, the start of an export) the cycle picks up
wherever the position is, with both looks of a transition taken from their presets. An export
therefore changes looks at exactly the frames the preview does.

A transition draws two complete looks. The look fading out keeps its own copy of the
parameters, which the audio goes on modulating, its own feedback history and its own palette.
Both looks run the whole pipeline into an 8-bit target, and `TransitionPass` blends the two
finished pictures onto the canvas: crossfade, screen, brightest first, or glitch blocks. At the
start of a transition the outgoing look gets a copy of the feedback history, so both continue
from the same picture. The GPU time doubles while a transition runs, about 2 ms at 1080p.

Loading a preset changes nearly every parameter at once. The control panel therefore updates
one section per frame after a bulk change, rebuilds a section only when its set of controls
changes, and leaves rows alone whose value stayed the same. A change of look costs the frame
about 0.1 ms of script.

## Adding a generator

1. Write `src/effects/generators/rings.frag`:

   ```glsl
   // Rings: concentric circles that pulse with the bass.
   #include <math>

   uniform float p_count;
   uniform float p_react;

   void main() {
     vec2 p = centered(v_uv);
     float r = length(p) * p_count - u_audioTime;
     float ring = smoothstep(0.1, 0.0, abs(fract(r) - 0.5) - 0.1 * u_bass * p_react);
     fragColor = vec4(paletteAt(r * 0.1) * ring, 1.0);
   }
   ```

2. Describe it in `src/effects/generators/index.ts`:

   ```ts
   import rings from './rings.frag?raw';

   {
     id: 'gen.rings',
     label: 'Rings',
     description: 'Concentric circles that pulse with the bass',
     fragment: rings,
     params: [
       { key: 'count', label: 'Rings', type: 'float', min: 1, max: 40, step: 0.1, default: 12 },
       react,
     ],
   },
   ```

That is all. The generator appears in both layer selectors, gets its controls, takes part in
presets and Randomize, and can be modulated.

While the dev server runs, saving a shader recompiles it in place. The music keeps playing.
A shader that fails to compile keeps its previous version, and the error is shown on screen.
Changing a parameter list reloads the page.

## Adding a stage

Stages are listed in `src/effects/stages/index.ts` and run from `Renderer.render` in a fixed
order. To add one, describe it next to the others and add one line to `render`:

```ts
if (p.num('mystage.amount') > 0.001) current = stage('mystage', { u_input: current });
```

Its shader reads the previous stage from `u_input`.

## Tests

| File | Covers |
| --- | --- |
| `tests/analysis.test.ts` | FFT calibration, band mapping, onsets, beat clock, repeatability of the analysis |
| `tests/params.test.ts` | Validation, modulation, presets, optional groups, upgrading old presets, palettes |
| `tests/cycle.test.ts` | Cycle schedule, shuffled order without repeats, the cycle playing through and after a jump |
| `tests/export.test.ts` | Frame count and timing, identical inputs on every run, beat grid, cancelling |
| `tests/frameStats.test.ts` | Frame rate and late-frame measurement |
| `tests/bridge.test.ts` | Token and origin checks, approved paths, out-of-order writes, cancelling, a real FFmpeg encode |
| `tests/desktop.test.ts` | Settings file, private server, path traversal, content security policy, development proxy |
| `tests/brand.test.ts` | Product name and publisher agree between the app, `package.json` and the packaging |

Rendering and export were verified by running the app: frame captures of every generator,
stage and preset, and FFprobe checks of every export codec.

The packaged desktop application was verified by driving it through the DevTools protocol:
startup, live frame rate, every export path with FFmpeg removed from the `PATH`, rendering
while covered and while minimized, system audio capture against a test tone, and settings
surviving a restart. The system save dialog cannot be driven that way and was not exercised
end to end. The approval logic behind it is covered by `tests/bridge.test.ts`.

## Next steps

| Feature | Approach |
| --- | --- |
| MIDI control with learn | Web MIDI writing into `ParamStore` |
| Separate output window | Second shell window on the projector showing the canvas stream, controls stay on the first screen |
| OSC control | UDP listener in the shell's main process, forwarded to `ParamStore` |
| Spout, NDI | Native module in the shell that takes frames from the canvas |
| macOS and Linux builds | The shell is portable. Needs a build on each system and another way to capture system audio |
| Video or webcam as image layer | The image texture already accepts any `TexImageSource` |
| Hand-picked cycle | A per-preset switch for taking part in the cycle, stored with the user presets |
| Reorderable stage chain | Turn the fixed order in `Renderer.render` into a list stored in the preset |
