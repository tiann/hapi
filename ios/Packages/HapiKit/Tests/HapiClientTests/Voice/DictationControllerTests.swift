import Foundation
import HapiClient
import HapiProtocol
import Testing

// Transcription of the Android `DictationControllerTest` against the iOS
// controller (fake transport + fake recorder seams).

// MARK: - Fakes

private struct TestError: LocalizedError, Equatable, Sendable {
    let message: String
    var errorDescription: String? { message }
}

private actor FakeDictationApi: DictationTranscribing {
    struct TranscribeCall: Sendable {
        let audio: Data
        let filename: String
        let mimeType: String
        let provider: String
        let language: String?
    }

    private var providersResult = TranscriptionProvidersResponse(providers: [
        TranscriptionProviderInfo(id: "openai", label: "OpenAI", modes: ["standard", "realtime"]),
        TranscriptionProviderInfo(id: "groq", label: "Groq", modes: ["standard"]),
    ])
    private var providersFailure: TestError?
    private(set) var providersCalls = 0

    private var transcribeResult = TranscriptionResponse(text: "hello world")
    private var transcribeFailure: TestError?
    private(set) var transcribeCalls: [TranscribeCall] = []

    func setProviders(_ result: TranscriptionProvidersResponse) {
        providersResult = result
    }

    func setProvidersFailure(_ message: String) {
        providersFailure = TestError(message: message)
    }

    func setTranscribeFailure(_ message: String) {
        transcribeFailure = TestError(message: message)
    }

    func transcriptionProviders() async throws -> TranscriptionProvidersResponse {
        providersCalls += 1
        if let providersFailure {
            throw providersFailure
        }
        return providersResult
    }

    func transcribe(
        audio: Data,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?
    ) async throws -> TranscriptionResponse {
        transcribeCalls.append(TranscribeCall(
            audio: audio,
            filename: filename,
            mimeType: mimeType,
            provider: provider,
            language: language
        ))
        if let transcribeFailure {
            throw transcribeFailure
        }
        return transcribeResult
    }
}

@MainActor
private final class FakeRecorder: DictationRecorder {
    let filename = "speech.m4a"
    let mimeType = "audio/mp4"

    var startFailure: TestError?
    var stopResult: Data? = Data([1, 2, 3])
    private(set) var startCalls = 0
    private(set) var stopCalls = 0
    private(set) var cancelCalls = 0

    func start() throws {
        startCalls += 1
        if let startFailure {
            throw startFailure
        }
    }

    func stop() throws -> Data? {
        stopCalls += 1
        return stopResult
    }

    func cancel() {
        cancelCalls += 1
    }
}

// MARK: - Harness

@MainActor
private final class DictationHarness {
    let api = FakeDictationApi()
    let recorder = FakeRecorder()
    private(set) var events: [DictationEvent] = []
    let controller: DictationController

    init() {
        controller = DictationController(api: api, recorder: recorder, now: { 42_000 })
        controller.onEvent = { [weak self] event in
            self?.events.append(event)
        }
    }
}

/// Polls `condition` (10 ms cadence) until true or timeout.
@MainActor
private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () async -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

// MARK: - Tests

@Suite("DictationController")
@MainActor
struct DictationControllerTests {

    @Test func recordThenStopUploadsTheTakeAndEmitsTheTranscript() async throws {
        let harness = DictationHarness()

        harness.controller.toggle()
        #expect(await eventually {
            harness.controller.state == .recording(startedAtMs: 42_000)
        })
        #expect(harness.recorder.startCalls == 1)

        harness.controller.toggle()
        #expect(await eventually { harness.controller.state == .idle })

        let calls = await harness.api.transcribeCalls
        let call = try #require(calls.first)
        #expect(calls.count == 1)
        #expect(call.audio == Data([1, 2, 3]))
        #expect(call.filename == "speech.m4a")
        #expect(call.mimeType == "audio/mp4")
        // First provider supporting standard mode wins.
        #expect(call.provider == "openai")
        #expect(call.language == nil)
        #expect(harness.events == [.transcribed("hello world")])
    }

    @Test func providerDiscoveryIsMemoizedAcrossTakes() async throws {
        let harness = DictationHarness()

        for _ in 0..<2 {
            harness.controller.toggle()
            #expect(await eventually {
                if case .recording = harness.controller.state { return true }
                return false
            })
            harness.controller.toggle()
            #expect(await eventually { harness.controller.state == .idle })
        }

        #expect(await harness.api.providersCalls == 1)
        #expect(await harness.api.transcribeCalls.count == 2)
    }

    @Test func noStandardCapableProviderEmitsNoProviderAndNeverRecords() async throws {
        let harness = DictationHarness()
        // Realtime-only (browser-local shape) must not qualify.
        await harness.api.setProviders(TranscriptionProvidersResponse(providers: [
            TranscriptionProviderInfo(id: "browser-local", label: "Browser", modes: ["realtime"]),
        ]))

        harness.controller.toggle()
        #expect(await eventually {
            harness.controller.state == .idle && !harness.events.isEmpty
        })

        #expect(harness.events == [.noProvider])
        #expect(harness.recorder.startCalls == 0)
    }

    @Test func providerDiscoveryFailureSurfacesAsAnError() async throws {
        let harness = DictationHarness()
        await harness.api.setProvidersFailure("hub unreachable")

        harness.controller.toggle()
        #expect(await eventually {
            harness.controller.state == .idle && !harness.events.isEmpty
        })

        #expect(harness.events == [.error("hub unreachable")])
        #expect(harness.recorder.startCalls == 0)
    }

    @Test func recorderStartFailureSurfacesAsAnError() async throws {
        let harness = DictationHarness()
        harness.recorder.startFailure = TestError(message: "mic busy")

        harness.controller.toggle()
        #expect(await eventually {
            harness.controller.state == .idle && !harness.events.isEmpty
        })

        #expect(harness.events == [.error("mic busy")])
        #expect(await harness.api.transcribeCalls.isEmpty)
    }

    @Test func emptyTakeReportsNoAudioWithoutUploading() async throws {
        let harness = DictationHarness()
        harness.recorder.stopResult = nil

        harness.controller.toggle()
        #expect(await eventually {
            if case .recording = harness.controller.state { return true }
            return false
        })
        harness.controller.toggle()
        #expect(await eventually {
            harness.controller.state == .idle && !harness.events.isEmpty
        })

        #expect(harness.events == [.error("No audio was recorded")])
        #expect(await harness.api.transcribeCalls.isEmpty)
    }

    @Test func transcriptionFailureEmitsTheErrorAndReturnsToIdle() async throws {
        let harness = DictationHarness()
        await harness.api.setTranscribeFailure("upload exploded")

        harness.controller.toggle()
        #expect(await eventually {
            if case .recording = harness.controller.state { return true }
            return false
        })
        harness.controller.toggle()
        #expect(await eventually {
            harness.controller.state == .idle && !harness.events.isEmpty
        })

        #expect(harness.events == [.error("upload exploded")])
    }

    @Test func cancelDiscardsTheTakeWithoutUploading() async throws {
        let harness = DictationHarness()

        harness.controller.toggle()
        #expect(await eventually {
            if case .recording = harness.controller.state { return true }
            return false
        })
        harness.controller.cancel()

        #expect(harness.controller.state == .idle)
        #expect(harness.recorder.cancelCalls == 1)
        #expect(harness.recorder.stopCalls == 0)
        #expect(await harness.api.transcribeCalls.isEmpty)
        #expect(harness.events.isEmpty)
    }
}

@Suite("appendTranscript")
struct AppendTranscriptTests {

    @Test func appendsWithASingleSpaceSeparator() {
        #expect(appendTranscript("draft text", transcript: "new words") == "draft text new words")
    }

    @Test func doesNotDoubleSeparatorsAfterTrailingWhitespace() {
        #expect(appendTranscript("draft ", transcript: "ok") == "draft ok")
        #expect(appendTranscript("line\n", transcript: "ok") == "line\nok")
    }

    @Test func emptyComposerTakesTheTrimmedTranscriptVerbatim() {
        #expect(appendTranscript("", transcript: "  hello  ") == "hello")
    }

    @Test func blankTranscriptLeavesTheTextUntouched() {
        #expect(appendTranscript("draft", transcript: "   ") == "draft")
    }
}
