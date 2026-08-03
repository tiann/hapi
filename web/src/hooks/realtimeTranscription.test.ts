import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDeepgramRealtimeTranscription, startOpenAIRealtimeTranscription } from './realtimeTranscription'

describe('OpenAI realtime transcription', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('streams partial text and returns the committed final transcript', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: vi.fn(async () => ({
                    getTracks: () => [{ stop: stopTrack }],
                    getAudioTracks: () => [{ stop: stopTrack }]
                }))
            }
        })

        class MockDataChannel extends EventTarget {
            readyState = 'open'
            send = vi.fn()
            close = vi.fn()
        }
        const channel = new MockDataChannel()
        class MockPeerConnection extends EventTarget {
            connectionState = 'connected'
            createDataChannel() { return channel }
            addTrack() {}
            async createOffer() { return { type: 'offer', sdp: 'offer-sdp' } }
            async setLocalDescription() {}
            async setRemoteDescription() {}
            close() {}
        }
        vi.stubGlobal('RTCPeerConnection', MockPeerConnection)
        vi.stubGlobal('fetch', vi.fn(async () => new Response('answer-sdp', { status: 200 })))

        const callbacks = {
            onConnected: vi.fn(),
            onPartial: vi.fn(),
            onFinal: vi.fn(),
            onError: vi.fn()
        }
        const session = await startOpenAIRealtimeTranscription({
            getToken: async () => 'ephemeral-token',
            callbacks
        })
        channel.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({
                type: 'conversation.item.input_audio_transcription.delta',
                delta: 'live text'
            })
        }))
        expect(callbacks.onPartial).toHaveBeenCalledWith('live text')

        const stopping = session.stop()
        setTimeout(() => channel.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                transcript: 'final text'
            })
        })), 0)
        await stopping

        expect(callbacks.onFinal).toHaveBeenCalledWith('final text')
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(stopTrack).toHaveBeenCalled()
    })

    it('releases the microphone when startup is aborted', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: vi.fn(async () => ({
                    getTracks: () => [{ stop: stopTrack }],
                    getAudioTracks: () => [{ stop: stopTrack }]
                }))
            }
        })
        class MockDataChannel extends EventTarget {
            readyState = 'connecting'
            close() {}
        }
        class MockPeerConnection extends EventTarget {
            connectionState = 'connecting'
            createDataChannel() { return new MockDataChannel() }
            addTrack() {}
            async createOffer() { return { type: 'offer', sdp: 'offer-sdp' } }
            async setLocalDescription() {}
            close() {}
        }
        vi.stubGlobal('RTCPeerConnection', MockPeerConnection)
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
        vi.stubGlobal('fetch', fetchMock)
        const controller = new AbortController()
        const starting = startOpenAIRealtimeTranscription({
            getToken: async () => 'ephemeral-token',
            signal: controller.signal,
            callbacks: {
                onConnected: vi.fn(),
                onPartial: vi.fn(),
                onFinal: vi.fn(),
                onError: vi.fn()
            }
        })
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

        controller.abort()

        await expect(starting).rejects.toBeDefined()
        expect(stopTrack).toHaveBeenCalled()
    })
})

describe('Deepgram realtime transcription', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('streams recorder chunks and returns the finalized transcript', async () => {
        const stopTrack = vi.fn()
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: vi.fn(async () => ({
                    getTracks: () => [{ stop: stopTrack }]
                }))
            }
        })

        class MockSocket extends EventTarget {
            static OPEN = 1
            readyState = 0
            sent: unknown[] = []
            constructor(readonly url: string, readonly protocols: string[]) {
                super()
                queueMicrotask(() => {
                    this.readyState = MockSocket.OPEN
                    this.dispatchEvent(new Event('open'))
                })
            }
            send(value: unknown) { this.sent.push(value) }
            close() { this.readyState = 3 }
            result(transcript: string, final: boolean, fromFinalize = false) {
                this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'Results',
                        is_final: final,
                        from_finalize: fromFinalize,
                        channel: { alternatives: [{ transcript }] }
                    })
                }))
            }
        }
        const sockets: MockSocket[] = []
        class MockWebSocket extends MockSocket {
            constructor(url: string, protocols: string[]) {
                super(url, protocols)
                sockets.push(this)
            }
        }
        Object.assign(MockWebSocket, { OPEN: MockSocket.OPEN })
        vi.stubGlobal('WebSocket', MockWebSocket)

        class MockRecorder {
            static isTypeSupported() { return true }
            state = 'inactive'
            mimeType = 'audio/webm;codecs=opus'
            ondataavailable: ((event: { data: Blob }) => void) | null = null
            onerror: (() => void) | null = null
            onstop: (() => void) | null = null
            start() {
                this.state = 'recording'
                this.ondataavailable?.({ data: new Blob(['audio']) })
            }
            stop() {
                this.state = 'inactive'
                this.onstop?.()
            }
        }
        vi.stubGlobal('MediaRecorder', MockRecorder)

        const callbacks = {
            onConnected: vi.fn(),
            onPartial: vi.fn(),
            onFinal: vi.fn(),
            onError: vi.fn()
        }
        const session = await startDeepgramRealtimeTranscription({
            getToken: async () => 'temporary-jwt',
            callbacks
        })
        const socket = sockets[0]!
        expect(socket.protocols).toEqual(['bearer', 'temporary-jwt'])
        socket.result('live', false)
        const stopping = session.stop()
        socket.result('final text', true, true)
        await stopping

        expect(callbacks.onPartial).toHaveBeenCalledWith('live')
        expect(callbacks.onFinal).toHaveBeenCalledWith('final text')
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(stopTrack).toHaveBeenCalled()
    })
})
