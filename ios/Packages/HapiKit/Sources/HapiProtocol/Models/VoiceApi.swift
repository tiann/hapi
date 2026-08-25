import Foundation

// Wire types of the hub's voice surface (`hub/src/web/routes/voice.ts`),
// added for A-M3f dictation in lockstep with the Android port
// (`app.hapi.protocol.wire` — ApiResponses.kt). Only the standard
// (uploaded-file) transcription path is modeled; realtime tokens are out of
// scope for native v1.

/// Body of `POST /api/voice/transcription` (the one multipart endpoint).
public struct TranscriptionResponse: Codable, Equatable, Sendable {
    public var text: String
    public var language: String?

    public init(text: String, language: String? = nil) {
        self.text = text
        self.language = language
    }
}

/// Body of `GET /api/voice/transcription/providers` — only providers whose
/// keys are configured on the hub (`listConfiguredTranscriptionProviders`,
/// `shared/src/voice.ts`). Empty ⇒ dictation is unavailable.
public struct TranscriptionProvidersResponse: Codable, Equatable, Sendable {
    public var providers: [TranscriptionProviderInfo]

    public init(providers: [TranscriptionProviderInfo]) {
        self.providers = providers
    }
}

/// `TranscriptionProviderInfo` (`shared/src/voice.ts`).
public struct TranscriptionProviderInfo: Codable, Equatable, Sendable {
    /// `openai | elevenlabs | deepgram | groq | openai-compatible | browser-local`.
    public var id: String
    public var label: String
    /// Subset of `standard` / `realtime`; native dictation uses `standard`.
    public var modes: [String]

    public init(id: String, label: String, modes: [String]) {
        self.id = id
        self.label = label
        self.modes = modes
    }
}
