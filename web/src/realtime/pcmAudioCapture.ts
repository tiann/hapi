/**
 * Captures microphone audio as raw PCM16 (Int16) at 24kHz mono,
 * suitable for streaming to a Speaches/OpenAI-compatible Realtime API.
 *
 * Uses AudioWorklet for low-latency capture. Falls back to
 * ScriptProcessorNode on older browsers.
 */

const SAMPLE_RATE = 24000
const BUFFER_SIZE = 2400 // ~100ms at 24kHz

// Inline AudioWorklet processor source
const workletSource = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buffer = new Float32Array(${BUFFER_SIZE});
        this._offset = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const samples = input[0];
        for (let i = 0; i < samples.length; i++) {
            this._buffer[this._offset++] = samples[i];
            if (this._offset >= ${BUFFER_SIZE}) {
                // Convert float32 to int16
                const pcm16 = new Int16Array(${BUFFER_SIZE});
                for (let j = 0; j < ${BUFFER_SIZE}; j++) {
                    const s = Math.max(-1, Math.min(1, this._buffer[j]));
                    pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
                this._buffer = new Float32Array(${BUFFER_SIZE});
                this._offset = 0;
            }
        }
        return true;
    }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    const len = bytes.length
    let binary = ''
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
}

export class PcmAudioCapture {
    private audioContext: AudioContext | null = null
    private workletNode: AudioWorkletNode | null = null
    private scriptNode: ScriptProcessorNode | null = null
    private sourceNode: MediaStreamAudioSourceNode | null = null
    private mediaStream: MediaStream | null = null
    private onAudioData: ((pcm16: ArrayBuffer) => void) | null = null
    private muted = false

    async start(onAudioData: (pcm16: ArrayBuffer) => void): Promise<MediaStream> {
        this.onAudioData = onAudioData

        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            }
        })

        this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream)

        if (typeof AudioWorkletNode !== 'undefined') {
            await this.startWithWorklet()
        } else {
            this.startWithScriptProcessor()
        }

        return this.mediaStream
    }

    private async startWithWorklet(): Promise<void> {
        if (!this.audioContext || !this.sourceNode) return

        const blob = new Blob([workletSource], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        try {
            await this.audioContext.audioWorklet.addModule(url)
        } finally {
            URL.revokeObjectURL(url)
        }

        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor')
        this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            if (!this.muted && this.onAudioData) {
                this.onAudioData(event.data)
            }
        }

        this.sourceNode.connect(this.workletNode)
        // Connect to destination to keep the audio graph alive (silent output)
        this.workletNode.connect(this.audioContext.destination)
    }

    private startWithScriptProcessor(): void {
        if (!this.audioContext || !this.sourceNode) return

        // Deprecated but supported everywhere
        this.scriptNode = this.audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1)
        this.scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
            if (this.muted || !this.onAudioData) return

            const input = event.inputBuffer.getChannelData(0)
            const pcm16 = new Int16Array(input.length)
            for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]))
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
            }
            this.onAudioData(pcm16.buffer)
        }

        this.sourceNode.connect(this.scriptNode)
        this.scriptNode.connect(this.audioContext.destination)
    }

    setMuted(muted: boolean): void {
        this.muted = muted
    }

    stop(): void {
        if (this.workletNode) {
            this.workletNode.disconnect()
            this.workletNode.port.close()
            this.workletNode = null
        }

        if (this.scriptNode) {
            this.scriptNode.disconnect()
            this.scriptNode = null
        }

        if (this.sourceNode) {
            this.sourceNode.disconnect()
            this.sourceNode = null
        }

        if (this.audioContext) {
            void this.audioContext.close()
            this.audioContext = null
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop())
            this.mediaStream = null
        }

        this.onAudioData = null
    }
}
