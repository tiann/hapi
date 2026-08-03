import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    BROWSER_LOCAL_AVAILABILITY_TIMEOUT_MS,
    getBrowserLocalAvailabilityProbeSubscriberCountForTesting,
    startBrowserLocalTranscription,
    startDeepgramRealtimeTranscription,
    startOpenAIRealtimeTranscription
} from './realtimeTranscription'

function browserLocalCallbacks() {
    return {
        onConnected: vi.fn(),
        onPartial: vi.fn(),
        onFinal: vi.fn(),
        onError: vi.fn()
    }
}

function installBrowserLocalSpeechRecognition(available: () => Promise<string> | string, onConstruct = vi.fn()) {
    class MockSpeechRecognition extends EventTarget {
        static available = available
        continuous = false
        interimResults = false
        lang = ''
        processLocally = false
        onresult: ((event: Event) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        onend: (() => void) | null = null
        start = vi.fn()
        stop = vi.fn()
        abort = vi.fn()
        constructor() {
            super()
            onConstruct()
        }
    }
    Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', { value: false, writable: true })
    vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
    vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
        userAgentData: { platform: 'macOS', mobile: false },
        language: 'en-US'
    })
    return { available, onConstruct, constructor: MockSpeechRecognition }
}

describe('browser-local realtime transcription', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('calls available only after an explicit browser-local dictation start', async () => {
        const available = vi.fn(() => Promise.resolve('available'))
        installBrowserLocalSpeechRecognition(available)
        const callbacks = browserLocalCallbacks()

        const session = await startBrowserLocalTranscription({ language: 'en-US', callbacks })

        expect(available).toHaveBeenCalledOnce()
        expect(available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true })
        expect(callbacks.onConnected).toHaveBeenCalledOnce()
        session.cancel()
    })

    it('shares one successful native probe across concurrent browser-local starts', async () => {
        let resolveAvailable!: (status: string) => void
        const available = vi.fn(() => new Promise<string>((resolve) => { resolveAvailable = resolve }))
        const onConstruct = vi.fn()
        installBrowserLocalSpeechRecognition(available, onConstruct)
        const firstCallbacks = browserLocalCallbacks()
        const secondCallbacks = browserLocalCallbacks()

        const first = startBrowserLocalTranscription({ language: 'en-US', callbacks: firstCallbacks })
        const second = startBrowserLocalTranscription({ language: 'en-US', callbacks: secondCallbacks })
        await vi.waitFor(() => expect(available).toHaveBeenCalledOnce())

        resolveAvailable('available')
        const sessions = await Promise.all([first, second])

        expect(onConstruct).toHaveBeenCalledTimes(2)
        expect(firstCallbacks.onConnected).toHaveBeenCalledOnce()
        expect(secondCallbacks.onConnected).toHaveBeenCalledOnce()
        sessions.forEach((session) => session.cancel())
    })

    it('surfaces a synchronous available failure', async () => {
        const available = vi.fn(() => { throw new Error('native failure') })
        installBrowserLocalSpeechRecognition(available)

        await expect(startBrowserLocalTranscription({ language: 'en-US', callbacks: browserLocalCallbacks() }))
            .rejects.toThrow('native failure')
        expect(available).toHaveBeenCalledOnce()
    })

    it('surfaces a rejected available probe', async () => {
        const available = vi.fn(() => Promise.reject(new Error('probe rejected')))
        installBrowserLocalSpeechRecognition(available)

        await expect(startBrowserLocalTranscription({ language: 'en-US', callbacks: browserLocalCallbacks() }))
            .rejects.toThrow('probe rejected')
        expect(available).toHaveBeenCalledOnce()
    })

    it('times out a stalled available probe', async () => {
        vi.useFakeTimers()
        const available = vi.fn(() => new Promise<string>(() => {}))
        installBrowserLocalSpeechRecognition(available)
        const starting = startBrowserLocalTranscription({ language: 'en-US', callbacks: browserLocalCallbacks() })
        const expectation = expect(starting).rejects.toThrow('availability check timed out')

        await vi.advanceTimersByTimeAsync(BROWSER_LOCAL_AVAILABILITY_TIMEOUT_MS)

        await expectation
        expect(available).toHaveBeenCalledOnce()
    })

    it('does not invoke available when its start signal aborts before the native microtask', async () => {
        const available = vi.fn(() => Promise.resolve('available'))
        installBrowserLocalSpeechRecognition(available)
        const controller = new AbortController()
        const starting = startBrowserLocalTranscription({
            language: 'en-US',
            signal: controller.signal,
            callbacks: browserLocalCallbacks()
        })
        const expectation = expect(starting).rejects.toBeDefined()

        controller.abort()
        await expectation
        await Promise.resolve()

        expect(available).not.toHaveBeenCalled()
    })

    it('shares a stalled native probe across timeout retries and ignores its late result', async () => {
        vi.useFakeTimers()
        let resolveAvailable!: (status: string) => void
        const available = vi.fn(() => new Promise<string>((resolve) => { resolveAvailable = resolve }))
        const onConstruct = vi.fn()
        const speechRecognition = installBrowserLocalSpeechRecognition(available, onConstruct)
        const firstCallbacks = browserLocalCallbacks()
        const first = startBrowserLocalTranscription({ language: 'en-US', callbacks: firstCallbacks })
        const firstExpectation = expect(first).rejects.toThrow('availability check timed out')

        await vi.advanceTimersByTimeAsync(BROWSER_LOCAL_AVAILABILITY_TIMEOUT_MS)
        await firstExpectation
        expect(getBrowserLocalAvailabilityProbeSubscriberCountForTesting(speechRecognition.constructor, 'en-US')).toBe(0)

        const second = startBrowserLocalTranscription({ language: 'en-US', callbacks: browserLocalCallbacks() })
        const secondExpectation = expect(second).rejects.toThrow('availability check timed out')
        await vi.advanceTimersByTimeAsync(BROWSER_LOCAL_AVAILABILITY_TIMEOUT_MS)
        await secondExpectation
        expect(getBrowserLocalAvailabilityProbeSubscriberCountForTesting(speechRecognition.constructor, 'en-US')).toBe(0)

        const controller = new AbortController()
        const aborted = startBrowserLocalTranscription({
            language: 'en-US',
            signal: controller.signal,
            callbacks: browserLocalCallbacks()
        })
        const abortedExpectation = expect(aborted).rejects.toBeDefined()
        controller.abort()
        await abortedExpectation
        expect(getBrowserLocalAvailabilityProbeSubscriberCountForTesting(speechRecognition.constructor, 'en-US')).toBe(0)

        expect(available).toHaveBeenCalledOnce()
        resolveAvailable('available')
        await Promise.resolve()
        await Promise.resolve()
        expect(onConstruct).not.toHaveBeenCalled()
        expect(firstCallbacks.onConnected).not.toHaveBeenCalled()
    })

    it('rejects Android browser-local startup without calling a partial native available API', async () => {
        const available = vi.fn(() => Promise.resolve('available'))
        installBrowserLocalSpeechRecognition(available)
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Linux; Android 15; WebView)',
            userAgentData: { platform: 'Android', mobile: true },
            language: 'en-US'
        })

        await expect(startBrowserLocalTranscription({ language: 'en-US', callbacks: browserLocalCallbacks() }))
            .rejects.toThrow('not supported by this browser')
        expect(available).not.toHaveBeenCalled()
    })
})

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
