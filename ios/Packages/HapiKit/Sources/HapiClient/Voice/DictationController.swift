import Foundation
import HapiProtocol
import Observation

/// Append a finished transcript to the composer text with a single space
/// separator (web `appendTranscript`, `useDictation.ts`; Android twin in
/// `Dictation.kt`).
public func appendTranscript(_ text: String, transcript: String) -> String {
    let addition = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    if addition.isEmpty { return text }
    if text.isEmpty { return addition }
    let separator = text.last?.isWhitespace == true ? "" : " "
    return "\(text)\(separator)\(addition)"
}

/// Transport seam over the hub's two dictation endpoints (Android
/// `DictationApi`); ``APIClient`` conforms in `Endpoints/VoiceEndpoints.swift`,
/// tests drive a fake.
public protocol DictationTranscribing: Sendable {
    /// `GET /api/voice/transcription/providers`.
    func transcriptionProviders() async throws -> TranscriptionProvidersResponse

    /// `POST /api/voice/transcription` (multipart, `mode=standard`).
    func transcribe(
        audio: Data,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?
    ) async throws -> TranscriptionResponse
}

/// Recorder seam (production: the app-side `AVAudioRecorder` m4a/AAC impl;
/// tests: scripted bytes). Main-actor-bound like its one caller.
@MainActor
public protocol DictationRecorder: AnyObject {
    /// Container filename the produced audio should upload under (`speech.m4a`).
    var filename: String { get }

    /// MIME type of the produced audio (`audio/mp4`).
    var mimeType: String { get }

    /// Begin capturing; throws when the microphone cannot be opened.
    func start() throws

    /// Stop and finalize the take; the recorded bytes, or nil when nothing
    /// usable was captured. Throws on hard recorder failures.
    func stop() throws -> Data?

    /// Abandon the take, discarding any captured data.
    func cancel()
}

/// The mic button / recording chip state machine.
public enum DictationState: Equatable, Sendable {
    /// No take in progress — mic button shows the idle glyph.
    case idle

    /// Provider discovery / recorder spin-up after the first press.
    case starting

    /// Capturing; the chip derives elapsed time from `startedAtMs`.
    case recording(startedAtMs: Int)

    /// Upload + transcription in flight — mic button shows a spinner.
    case transcribing
}

/// One-shot dictation outcomes for the screen.
public enum DictationEvent: Equatable, Sendable {
    /// Final transcript — append to the composer via ``appendTranscript(_:transcript:)``.
    case transcribed(String)

    /// The hub has no transcription provider configured.
    case noProvider

    /// Recording or transcription failed (toast).
    case error(String)
}

/// Press-to-toggle dictation (A-M3f, transcribed from the Android B-M3ce
/// `DictationController`): the first ``toggle()`` discovers a provider
/// (`GET /providers`, first entry supporting `standard`; memoized) and starts
/// the recorder; the second stops it and posts the audio to
/// `POST /api/voice/transcription`, emitting ``DictationEvent/transcribed(_:)``
/// with the hub's text. ``cancel()`` abandons the take without uploading.
///
/// Web reference: `useDictation.ts` (standard mode; the realtime path is out
/// of scope for v1). No language override yet — the hub auto-detects; a
/// settings-backed `language` field is the M5 hook.
///
/// Plain constructor over two seams — package tests drive it with fakes.
/// One-shot outcomes surface through ``onEvent`` (the same callback pattern
/// as `ChatInteractor.onEvent`).
@MainActor @Observable
public final class DictationController {
    public private(set) var state: DictationState = .idle

    /// One-shot outcomes; set by the owning screen model.
    @ObservationIgnored public var onEvent: (@MainActor (DictationEvent) -> Void)?

    private let api: any DictationTranscribing
    private let recorder: any DictationRecorder
    private let now: () -> Int

    /// First successful discovery wins for the session (web keeps a provider
    /// setting; v1 has none).
    private var cachedProviderId: String?
    @ObservationIgnored private var operationRunning = false

    public init(
        api: any DictationTranscribing,
        recorder: any DictationRecorder,
        now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.api = api
        self.recorder = recorder
        self.now = now
    }

    /// Mic button press: Idle → record, Recording → stop + transcribe.
    public func toggle() {
        switch state {
        case .idle:
            startRecording()
        case .recording:
            stopAndTranscribe()
        case .starting, .transcribing:
            // An operation is already in flight.
            break
        }
    }

    /// Recording chip ✕: discard the take (no upload).
    public func cancel() {
        guard case .recording = state else { return }
        recorder.cancel()
        state = .idle
    }

    private func startRecording() {
        guard !operationRunning else { return }
        operationRunning = true
        state = .starting
        Task { [weak self] in
            guard let self else { return }
            defer { self.operationRunning = false }
            guard let provider = await self.resolveProvider() else {
                self.state = .idle
                return
            }
            self.cachedProviderId = provider
            do {
                try self.recorder.start()
                self.state = .recording(startedAtMs: self.now())
            } catch {
                self.emit(.error(Self.errorMessage(error, fallback: "Could not start recording")))
                self.state = .idle
            }
        }
    }

    /// The memoized or freshly discovered provider id, or nil after emitting
    /// the failure event.
    private func resolveProvider() async -> String? {
        if let cachedProviderId {
            return cachedProviderId
        }
        let providers: [TranscriptionProviderInfo]
        do {
            providers = try await api.transcriptionProviders().providers
        } catch {
            emit(.error(Self.errorMessage(error, fallback: "Could not reach the hub")))
            return nil
        }
        // First provider supporting standard (uploaded-file) transcription —
        // the hub lists them in its own preference order. `browser-local`
        // (realtime-only) never qualifies.
        guard let chosen = providers.first(where: { $0.modes.contains("standard") }) else {
            emit(.noProvider)
            return nil
        }
        return chosen.id
    }

    private func stopAndTranscribe() {
        guard let provider = cachedProviderId else { return } // unreachable: set before Recording
        guard !operationRunning else { return }
        operationRunning = true
        state = .transcribing
        Task { [weak self] in
            guard let self else { return }
            defer { self.operationRunning = false }
            let audio: Data?
            do {
                audio = try self.recorder.stop()
            } catch {
                self.emit(.error(Self.errorMessage(error, fallback: "Audio recording failed")))
                self.state = .idle
                return
            }
            guard let audio, !audio.isEmpty else {
                self.emit(.error("No audio was recorded"))
                self.state = .idle
                return
            }
            defer { self.state = .idle }
            do {
                let result = try await self.api.transcribe(
                    audio: audio,
                    filename: self.recorder.filename,
                    mimeType: self.recorder.mimeType,
                    provider: provider,
                    language: nil
                )
                self.emit(.transcribed(result.text))
            } catch {
                self.emit(.error(Self.errorMessage(error, fallback: "Transcription failed")))
            }
        }
    }

    private func emit(_ event: DictationEvent) {
        onEvent?(event)
    }

    private static func errorMessage(_ error: any Error, fallback: String) -> String {
        (error as? LocalizedError)?.errorDescription ?? fallback
    }
}
