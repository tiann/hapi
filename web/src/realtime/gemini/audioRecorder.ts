import workletUrl from './pcm-recorder.worklet.ts?url';
import { float32ToPcm16, arrayBufferToBase64 } from './pcmUtils';

export class GeminiAudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;

  async start(onChunk: (base64Pcm: string) => void, onError?: (error: Error) => void): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1 }
      });

      this.mediaStream.getTracks().forEach((track) => {
        track.onended = () => {
          if (onError) onError(new Error('Microphone disconnected'));
        };
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      try {
        await this.audioContext.audioWorklet.addModule(workletUrl);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-recorder-processor');
        this.workletNode.port.onmessage = (event) => {
          const pcm16 = float32ToPcm16(event.data.samples);
          const base64 = arrayBufferToBase64(pcm16);
          onChunk(base64);
        };
        this.sourceNode.connect(this.workletNode);
      } catch (e) {
        console.warn('AudioWorklet failed, falling back to ScriptProcessorNode', e);
        this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.scriptNode.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          const pcm16 = float32ToPcm16(new Float32Array(inputData));
          const base64 = arrayBufferToBase64(pcm16);
          onChunk(base64);
        };
        this.sourceNode.connect(this.scriptNode);
        this.scriptNode.connect(this.audioContext.destination);
      }
    } catch (e) {
      if (onError) onError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  stop(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => {
        track.onended = null;
        track.stop();
      });
      this.mediaStream = null;
    }

    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  setMuted(muted: boolean): void {
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    }
  }

  dispose(): void {
    this.stop();
  }
}
