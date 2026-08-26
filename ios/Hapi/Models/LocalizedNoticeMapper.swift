import Foundation

/// Display-point localization for user-facing strings emitted by HapiKit
/// (the package layer stays language-free, A-M5): a known package-produced
/// notice maps to its `Localizable.xcstrings` entry, everything else
/// (server-originated errors, dynamic content) passes through verbatim.
///
/// Covered sources: `ChatInteractor` notices, `DictationController` errors,
/// `MessageWindowController` tail-sync warnings, and the files models'
/// fallback errors. Low-value/debug package strings are deliberately not
/// mapped.
enum LocalizedNoticeMapper {
    static func map(_ message: String) -> String {
        guard knownMessages.contains(message) else { return message }
        return String(localized: String.LocalizationValue(message))
    }

    /// Exact strings the package can emit — each is a key in
    /// `Localizable.xcstrings` (hand-authored; runtime-built keys are not
    /// extracted by the compiler).
    private static let knownMessages: Set<String> = [
        // ChatInteractor
        "Attachments are still uploading — wait, or retry/remove the failed ones",
        "Failed to abort",
        "Session is inactive and could not be resumed",
        "Failed to cancel queued message",
        "Message cancelled — kept your current draft",
        "Already delivered to the agent",
        "Failed to steer message",
        "Request was already handled",
        "Request failed",
        "Failed to load models",
        "Failed to update session",
        "Draft parked to scratchlist",
        "Scratchlist is full (200 entries)",
        "Couldn't park the draft — check the hub connection",
        // DictationController
        "Could not start recording",
        "Could not reach the hub",
        "Audio recording failed",
        "No audio was recorded",
        "Transcription failed",
        // NewSessionLogic
        "Name needs at least one letter or digit",
        // MessageWindowController (degraded-sync banner)
        "Failed to synchronize messages",
        "Failed to load older messages",
        // FilesModel / FileViewerModel fallbacks
        "Git status unavailable",
        "Failed to list directory",
        "Failed to search files",
        "Failed to read file",
        "Failed to load diff",
    ]
}
