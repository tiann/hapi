import AVFoundation
import Foundation
import HapiClient

/// `DictationRecorder` over `AVAudioRecorder`: AAC in an MPEG-4 container
/// (`.m4a`), a format every hub transcription provider accepts (the contract
/// allows any `audio/` type or mp4; the web itself falls back to mp4 on
/// Safari). Mono 44.1 kHz @ 96 kbps keeps minutes of speech far below the
/// endpoint's 25 MB cap. Mirrors the Android `MediaRecorderDictation`.
///
/// Requires `NSMicrophoneUsageDescription` (Info.plist) and the record
/// permission — the composer requests it before `start()`.
@MainActor
final class AVAudioRecorderDictation: DictationRecorder {
    let filename = "speech.m4a"
    let mimeType = "audio/mp4"

    private var recorder: AVAudioRecorder?
    private var output: URL?

    enum RecorderError: LocalizedError {
        case alreadyRecording
        case couldNotStart

        var errorDescription: String? {
            switch self {
            case .alreadyRecording:
                return "A recording is already in progress"
            case .couldNotStart:
                return "Could not start recording"
            }
        }
    }

    func start() throws {
        guard recorder == nil else { throw RecorderError.alreadyRecording }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 96_000,
        ]
        do {
            let audioRecorder = try AVAudioRecorder(url: url, settings: settings)
            guard audioRecorder.record() else {
                throw RecorderError.couldNotStart
            }
            recorder = audioRecorder
            output = url
        } catch {
            try? FileManager.default.removeItem(at: url)
            deactivateSession()
            throw error
        }
    }

    func stop() throws -> Data? {
        guard let audioRecorder = recorder, let url = output else { return nil }
        recorder = nil
        output = nil
        audioRecorder.stop()
        deactivateSession()
        defer { try? FileManager.default.removeItem(at: url) }
        // A take stopped immediately after start may hold no usable audio —
        // treat as an empty take (the controller reports it).
        guard let bytes = try? Data(contentsOf: url), !bytes.isEmpty else { return nil }
        return bytes
    }

    func cancel() {
        guard let audioRecorder = recorder else { return }
        recorder = nil
        audioRecorder.stop()
        audioRecorder.deleteRecording()
        if let url = output {
            try? FileManager.default.removeItem(at: url)
        }
        output = nil
        deactivateSession()
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
