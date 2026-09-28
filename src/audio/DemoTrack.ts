import { createRng } from '../util/math';

/**
 * Synthesizes the built-in demo loop: eight bars of drum and bass at any tempo.
 * It exists so the visualizer has something to react to before any audio is loaded,
 * and so exports can be tested without a music file. Rendering is deterministic.
 */

export const DEMO_DEFAULT_BPM = 174;
const BARS = 8;
const STEPS_PER_BAR = 16;

const KICK_STEPS = [0, 10];
const SNARE_STEPS = [4, 12];
const GHOST_KICK_BARS = [1, 3, 5, 7];

/** Root notes per bar for the bass, in Hz (A minor to F). */
const BASS_NOTES = [55.0, 55.0, 55.0, 65.41, 43.65, 43.65, 43.65, 49.0];
const CHORDS = [
  [220.0, 261.63, 329.63],
  [220.0, 261.63, 329.63],
  [220.0, 261.63, 329.63],
  [261.63, 329.63, 392.0],
  [174.61, 220.0, 261.63],
  [174.61, 220.0, 261.63],
  [174.61, 220.0, 261.63],
  [196.0, 246.94, 293.66],
];
const ARP = [880.0, 1046.5, 1318.5, 1760.0, 1318.5, 1046.5, 1568.0, 1174.7];

export async function renderDemoTrack(
  sampleRate: number,
  bpm: number = DEMO_DEFAULT_BPM,
): Promise<AudioBuffer> {
  const step = 60 / bpm / 4;
  const bar = step * STEPS_PER_BAR;
  const duration = bar * BARS;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);

  const master = ctx.createGain();
  master.gain.value = 0.85;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(limiter).connect(ctx.destination);

  // Everything except the drums ducks under the kick, like a sidechain compressor.
  const duck = ctx.createGain();
  duck.connect(master);

  const noise = createNoise(ctx, sampleRate);

  for (let b = 0; b < BARS; b++) {
    const t0 = b * bar;
    const lastBar = b === BARS - 1;

    const kicks = [...KICK_STEPS];
    if (GHOST_KICK_BARS.includes(b)) kicks.push(7);
    for (const s of kicks) {
      const t = t0 + s * step;
      kick(ctx, master, noise, t, s === 7 ? 0.55 : 1);
      duck.gain.setValueAtTime(0.25, t);
      duck.gain.exponentialRampToValueAtTime(1, t + 0.22);
    }
    for (const s of SNARE_STEPS) snare(ctx, master, noise, t0 + s * step, 1);
    if (lastBar) {
      // Snare roll into the loop point.
      for (let s = 12; s < 16; s++) snare(ctx, master, noise, t0 + (s + 0.5) * step, 0.35 + (s - 12) * 0.12);
    }

    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const t = t0 + s * step;
      const offbeat = s % 4 === 2;
      const open = s === 14 || (b % 2 === 1 && s === 6);
      hat(ctx, master, noise, t, s % 2 === 0 ? (offbeat ? 0.5 : 0.32) : 0.16, open ? 0.16 : 0.035);

      arp(ctx, duck, t, ARP[(s + b * 3) % ARP.length]!, b >= 4 ? 0.07 : 0.045, step);
    }

    bass(ctx, duck, t0, bar, BASS_NOTES[b]!);
    chord(ctx, duck, t0, bar, step, CHORDS[b]!);
  }

  riser(ctx, master, noise, (BARS - 1) * bar, bar);
  return ctx.startRendering();
}

function createNoise(ctx: BaseAudioContext, sampleRate: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, sampleRate * 2, sampleRate);
  const data = buffer.getChannelData(0);
  const rng = createRng(1337);
  for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
  return buffer;
}

function noiseSource(ctx: BaseAudioContext, noise: AudioBuffer, t: number, length: number): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  source.start(t, (t * 0.618) % 1.5);
  source.stop(t + length);
  return source;
}

function kick(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, velocity: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(47, t + 0.09);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(velocity, t + 0.003);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  osc.connect(amp).connect(out);
  osc.start(t);
  osc.stop(t + 0.36);

  const click = noiseSource(ctx, noise, t, 0.02);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const clickAmp = ctx.createGain();
  clickAmp.gain.setValueAtTime(0.25 * velocity, t);
  clickAmp.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  click.connect(hp).connect(clickAmp).connect(out);
}

function snare(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, velocity: number): void {
  const source = noiseSource(ctx, noise, t, 0.22);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2100;
  bp.Q.value = 0.7;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.75 * velocity, t + 0.002);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  source.connect(bp).connect(amp).connect(out);

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(240, t);
  body.frequency.exponentialRampToValueAtTime(170, t + 0.06);
  const bodyAmp = ctx.createGain();
  bodyAmp.gain.setValueAtTime(0.5 * velocity, t);
  bodyAmp.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  body.connect(bodyAmp).connect(out);
  body.start(t);
  body.stop(t + 0.12);
}

function hat(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, velocity: number, decay: number): void {
  const source = noiseSource(ctx, noise, t, decay + 0.02);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7500;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.4 * velocity, t + 0.001);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.sin(t * 9.1) * 0.35;
  source.connect(hp).connect(amp).connect(pan).connect(out);
}

function bass(ctx: BaseAudioContext, out: AudioNode, t: number, length: number, freq: number): void {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 5;
  // The filter sweeps open and shut twice per bar for the rolling "reese" movement.
  filter.frequency.setValueAtTime(180, t);
  filter.frequency.exponentialRampToValueAtTime(950, t + length * 0.25);
  filter.frequency.exponentialRampToValueAtTime(220, t + length * 0.5);
  filter.frequency.exponentialRampToValueAtTime(1300, t + length * 0.75);
  filter.frequency.exponentialRampToValueAtTime(180, t + length);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.34, t + 0.02);
  amp.gain.setValueAtTime(0.34, t + length - 0.03);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
  filter.connect(amp).connect(out);

  for (const detune of [-14, 0, 13]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + length);
  }
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = freq;
  const subAmp = ctx.createGain();
  subAmp.gain.value = 0.9;
  sub.connect(subAmp).connect(amp);
  sub.start(t);
  sub.stop(t + length);
}

function chord(ctx: BaseAudioContext, out: AudioNode, t: number, length: number, step: number, notes: number[]): void {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2400;
  filter.Q.value = 1.2;
  const gate = ctx.createGain();
  gate.gain.setValueAtTime(0.0001, t);
  // Off-beat stabs.
  for (let s = 2; s < STEPS_PER_BAR; s += 4) {
    const ts = t + s * step;
    gate.gain.setValueAtTime(0.0001, ts);
    gate.gain.exponentialRampToValueAtTime(0.09, ts + 0.005);
    gate.gain.exponentialRampToValueAtTime(0.0001, ts + step * 1.8);
  }
  filter.connect(gate).connect(out);
  for (const note of notes) {
    for (const detune of [-8, 8]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = note;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + length);
    }
  }
}

function arp(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, level: number, step: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(level, t + 0.003);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + step * 0.9);
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.sin(t * 5.3) * 0.6;
  osc.connect(amp).connect(pan).connect(out);
  osc.start(t);
  osc.stop(t + step);
}

function riser(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, length: number): void {
  const source = noiseSource(ctx, noise, t, length);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(9000, t + length);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.22, t + length * 0.95);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
  source.connect(bp).connect(amp).connect(out);
}
