import Foundation
import HapiProtocol

/// Voice transcription (`docs/api/client-contract/rest.md`), added for A-M3f
/// dictation — mirrors the Android `HapiApi` voice methods.
extension APIClient {
    /// `GET /api/voice/transcription/providers` — providers whose keys are
    /// configured on the hub. Dictation picks the first entry supporting
    /// `standard`; an empty list means no transcription provider is
    /// configured.
    public func transcriptionProviders() async throws -> TranscriptionProvidersResponse {
        try await request(.get, "/api/voice/transcription/providers")
    }

    /// `POST /api/voice/transcription` — the one `multipart/form-data`
    /// endpoint: `file` (≤ 25 MB audio), `provider`, `mode`, optional
    /// `language` (BCP-47-ish). Field order mirrors the Android client
    /// (file, provider, mode, language).
    public func transcribeVoice(
        audio: Data,
        filename: String,
        mimeType: String,
        provider: String,
        mode: String = "standard",
        language: String? = nil
    ) async throws -> TranscriptionResponse {
        var form = MultipartFormData()
        form.appendFile(fieldName: "file", filename: filename, mimeType: mimeType, data: audio)
        form.appendField(name: "provider", value: provider)
        form.appendField(name: "mode", value: mode)
        if let language {
            form.appendField(name: "language", value: language)
        }
        return try await request(
            .post,
            "/api/voice/transcription",
            rawBody: form.encodedBody(),
            contentType: form.contentType
        )
    }
}

/// `DictationController` transport seam (the Android `HapiDictationApi`
/// adapter collapses to a conformance here).
extension APIClient: DictationTranscribing {
    public func transcribe(
        audio: Data,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?
    ) async throws -> TranscriptionResponse {
        try await transcribeVoice(
            audio: audio,
            filename: filename,
            mimeType: mimeType,
            provider: provider,
            mode: "standard",
            language: language
        )
    }
}
