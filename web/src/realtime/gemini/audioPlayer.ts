import { base64ToArrayBuffer, pcm16ToFloat32 } from './pcmUtils';

export class GeminiAudioPlayer {
  private audioContext: AudioContext;
  private ownsContext: boolean;
  private lastEndTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor(audioContext?: AudioContext) {
    if (audioContext) {
      this.audioContext = audioContext;
      this.ownsContext = false;
    } else {
      this.audioContext = new AudioContext({ sampleRate: 24000 });
      this.ownsContext = true;
    }
    this.lastEndTime = this.audioContext.currentTime;
  }

  enqueue(base64Pcm: string): void {
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const arrayBuffer = base64ToArrayBuffer(base64Pcm);
    const float32Data = pcm16ToFloat32(arrayBuffer);
    
    if (float32Data.length === 0) return;

    const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
    audioBuffer.copyToChannel(new Float32Array(float32Data), 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const startTime = Math.max(this.audioContext.currentTime, this.lastEndTime);
    
    source.onended = () => {
      const index = this.activeSources.indexOf(source);
      if (index > -1) {
        this.activeSources.splice(index, 1);
      }
    };

    source.start(startTime);
    this.activeSources.push(source);

    this.lastEndTime = startTime + audioBuffer.duration;
  }

  clearQueue(): void {
    this.activeSources.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // Ignore if already stopped
      }
      source.disconnect();
    });
    this.activeSources = [];
    this.lastEndTime = this.audioContext.currentTime;
  }

  isPlaying(): boolean {
    return this.lastEndTime > this.audioContext.currentTime;
  }

  dispose(): void {
    this.clearQueue();
    if (this.ownsContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}
