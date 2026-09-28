/**
 * Audio tap. Runs on the audio thread, mixes its input down to mono and posts fixed-size
 * blocks to the main thread, where the analyzer consumes them at a fixed hop size.
 *
 * It keeps posting silence while nothing is connected so that envelopes decay naturally.
 */

// Minimal declarations for the AudioWorklet global scope.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const BLOCK = 256;

class TapProcessor extends AudioWorkletProcessor {
  private block = new Float32Array(BLOCK);
  private fill = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const channels = input ? input.length : 0;
    const frames = channels > 0 ? input![0]!.length : 128;

    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input![c]![i]!;
      this.block[this.fill++] = channels > 0 ? sample / channels : 0;
      if (this.fill === BLOCK) {
        // Posting copies the data, so the block can be reused without allocating here.
        this.port.postMessage(this.block);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('tap', TapProcessor);
