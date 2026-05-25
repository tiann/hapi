// AudioWorklet processor runs in a separate scope with its own globals.
// These declarations satisfy TypeScript without pulling in DOM lib types.
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

class PcmRecorderProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array;
  private bufferSize = 4096;
  private bufferIndex = 0;

  constructor() {
    super();
    this.buffer = new Float32Array(this.bufferSize);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.bufferIndex++] = channel[i];
        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage({ samples: this.buffer.slice() });
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
