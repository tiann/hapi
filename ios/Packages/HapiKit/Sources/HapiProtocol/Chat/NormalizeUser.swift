import Foundation

// Port of web/src/chat/normalizeUser.ts.

/// Port of `parseAttachments`: entries are accepted only when `id`,
/// `filename`, `mimeType` (strings), `size` (number) and `path` (string) are
/// all present; invalid entries are skipped and an empty result means
/// "no attachments" (`nil`).
func parseAttachments(_ raw: JSONValue?) -> [AttachmentMetadata]? {
    guard let items = raw?.arrayValue else { return nil }
    var attachments: [AttachmentMetadata] = []
    for item in items {
        guard let object = item.objectValue,
              let id = object["id"]?.stringValue,
              let filename = object["filename"]?.stringValue,
              let mimeType = object["mimeType"]?.stringValue,
              let size = object["size"]?.numberValue,
              let path = object["path"]?.stringValue,
              // The wire model stores byte sizes as Int; real sizes are
              // always integral (TS would accept a fractional number).
              let intSize = Int(exactly: size)
        else { continue }
        attachments.append(AttachmentMetadata(
            id: id,
            filename: filename,
            mimeType: mimeType,
            size: intSize,
            path: path,
            previewUrl: object["previewUrl"]?.stringValue
        ))
    }
    return attachments.isEmpty ? nil : attachments
}

/// Port of `normalizeUserRecord`.
func normalizeUserRecord(
    messageId: String,
    localId: String?,
    createdAt: Int,
    content: JSONValue,
    meta: JSONValue?
) -> NormalizedMessage? {
    if let text = content.stringValue {
        return NormalizedMessage(
            id: messageId,
            localId: localId,
            createdAt: createdAt,
            content: .user(text: text, attachments: nil),
            isSidechain: false,
            meta: meta
        )
    }

    if let object = content.objectValue,
       object["type"] == .string("text"),
       let text = object["text"]?.stringValue {
        let attachments = parseAttachments(object["attachments"])
        return NormalizedMessage(
            id: messageId,
            localId: localId,
            createdAt: createdAt,
            content: .user(text: text, attachments: attachments),
            isSidechain: false,
            meta: meta
        )
    }

    return nil
}
