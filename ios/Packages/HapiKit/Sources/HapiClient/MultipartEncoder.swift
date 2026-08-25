import Foundation

/// Minimal `multipart/form-data` builder for the one multipart endpoint,
/// `POST /api/voice/transcription` (M4c dictation): text fields plus one
/// file part.
///
/// The boundary is injectable so tests can compare exact bytes; production
/// callers use the random default. Append order is preserved.
public struct MultipartFormData: Sendable {
    public let boundary: String
    private var body = Data()

    public init(boundary: String = MultipartFormData.makeBoundary()) {
        self.boundary = boundary
    }

    public static func makeBoundary() -> String {
        "hapi.boundary.\(UUID().uuidString)"
    }

    /// Value for the request's `Content-Type` header.
    public var contentType: String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// Appends a plain text field.
    public mutating func appendField(name: String, value: String) {
        appendString("--\(boundary)\r\n")
        appendString("Content-Disposition: form-data; name=\"\(Self.sanitize(name))\"\r\n\r\n")
        appendString(value)
        appendString("\r\n")
    }

    /// Appends a file part.
    public mutating func appendFile(fieldName: String, filename: String, mimeType: String, data: Data) {
        appendString("--\(boundary)\r\n")
        appendString(
            "Content-Disposition: form-data; name=\"\(Self.sanitize(fieldName))\"; "
                + "filename=\"\(Self.sanitize(filename))\"\r\n"
        )
        appendString("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        appendString("\r\n")
    }

    /// The complete request body, including the closing boundary. The
    /// builder stays usable (value semantics) — encoding does not consume it.
    public func encodedBody() -> Data {
        var encoded = body
        encoded.append(Data("--\(boundary)--\r\n".utf8))
        return encoded
    }

    private mutating func appendString(_ string: String) {
        body.append(Data(string.utf8))
    }

    /// Header values must not smuggle CRLF or unescaped quotes.
    private static func sanitize(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\"", with: "%22")
    }
}
