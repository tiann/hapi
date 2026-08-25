import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

// Transcription of the Android `ComposerAttachmentsTest` against the iOS
// tray. The tray runs over the REAL `APIClient`/`AuthManager` with only HTTP
// scripted, so the upload JSON (base64 payload included) is asserted as the
// exact bytes the app sends.

private let attachSessionID = "sess-att"

// MARK: - Routing performer

/// Answers the two upload routes — `POST …/upload` (scripted FIFO, else
/// success with a filename-derived path; optionally parked on a gate) and
/// `POST …/upload/delete` (always success) — and records every exchange.
private actor UploadRoutingPerformer: HTTPPerforming {
    struct Exchange: Sendable {
        let method: String
        let path: String
        let body: String?
    }

    private(set) var exchanges: [Exchange] = []
    private var uploadResults: [(status: Int, json: String)] = []
    private var uploadsGated = false
    private var gateWaiters: [CheckedContinuation<Void, Never>] = []

    /// One-shot upload responses, consumed FIFO; empty ⇒ derived success.
    func scriptUpload(status: Int = 200, json: String) {
        uploadResults.append((status, json))
    }

    /// Parks subsequent uploads until ``openGate()`` (in-flight state tests).
    func gateUploads() {
        uploadsGated = true
    }

    func openGate() {
        uploadsGated = false
        let waiters = gateWaiters
        gateWaiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }

    func bodies(pathSuffix: String) -> [String] {
        exchanges.filter { $0.path.hasSuffix(pathSuffix) }.compactMap(\.body)
    }

    func count(pathSuffix: String) -> Int {
        exchanges.filter { $0.path.hasSuffix(pathSuffix) }.count
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        exchanges.append(Exchange(
            method: request.httpMethod ?? "GET",
            path: path,
            body: request.httpBody.map { String(decoding: $0, as: UTF8.self) }
        ))

        var status = 200
        let json: String
        if path.hasSuffix("/upload/delete") {
            json = #"{"success":true}"#
        } else if path.hasSuffix("/upload") {
            if uploadsGated {
                await withCheckedContinuation { continuation in
                    gateWaiters.append(continuation)
                }
            }
            if !uploadResults.isEmpty {
                let scripted = uploadResults.removeFirst()
                status = scripted.status
                json = scripted.json
            } else {
                struct UploadBody: Decodable { let filename: String }
                let filename = request.httpBody
                    .flatMap { try? JSONDecoder().decode(UploadBody.self, from: $0) }?
                    .filename ?? "file"
                json = "{\"success\":true,\"path\":\"/uploads/\(filename)\"}"
            }
        } else {
            json = "{}"
        }

        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: status,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            throw URLError(.badURL)
        }
        return (Data(json.utf8), response)
    }
}

// MARK: - Harness

@MainActor
private struct TrayHarness {
    let performer: UploadRoutingPerformer
    let tray: ComposerAttachments

    init() throws {
        let performer = UploadRoutingPerformer()
        self.performer = performer
        let baseURL = try #require(URL(string: testHubURLString))
        let credentials = InMemoryCredentialStore()
        try credentials.store(HubCredentials(
            hubUrl: testHubURLString,
            accessToken: "access-token",
            jwt: freshJWT()
        ))
        let auth = AuthManager(
            baseURL: baseURL,
            credentialStore: credentials,
            performer: performer,
            now: { testNow }
        )
        let api = APIClient(baseURL: baseURL, authManager: auth, performer: performer)
        tray = ComposerAttachments(api: api, sessionId: attachSessionID)
    }
}

private func prepared(
    id: String = "att-1",
    filename: String = "shot.jpg",
    mimeType: String = "image/jpeg",
    bytes: Data = Data([10, 20, 30]),
    previewBytes: Data? = Data([1, 2])
) -> PreparedAttachment {
    PreparedAttachment(
        id: id,
        filename: filename,
        mimeType: mimeType,
        bytes: bytes,
        previewBytes: previewBytes
    )
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

@Suite("ComposerAttachments")
@MainActor
struct ComposerAttachmentsTests {

    @Test func addUploadsImmediatelyWithTheExactBase64PayloadAndSettlesReady() async throws {
        let harness = try TrayHarness()

        harness.tray.add(prepared(bytes: Data([10, 20, 30])))

        #expect(await eventually {
            harness.tray.items.count == 1 && harness.tray.items[0].status == .ready
        })
        let chip = harness.tray.items[0]
        #expect(chip.filename == "shot.jpg")
        #expect(chip.sizeBytes == 3)
        #expect(harness.tray.allReady)

        let expectedBase64 = Data([10, 20, 30]).base64EncodedString()
        let uploads = await harness.performer.bodies(pathSuffix: "/api/sessions/sess-att/upload")
        #expect(uploads == [
            "{\"content\":\"\(expectedBase64)\",\"filename\":\"shot.jpg\",\"mimeType\":\"image/jpeg\"}"
        ])
    }

    @Test func consumeMapsReadyChipsToMetadataWithAPreviewDataURLAndClearsTheTray() async throws {
        let harness = try TrayHarness()
        harness.tray.add(prepared(previewBytes: Data([9, 9])))
        #expect(await eventually {
            harness.tray.items.count == 1 && harness.tray.items[0].status == .ready
        })

        let metadata = try #require(harness.tray.consume()?.first)

        #expect(metadata.id == "att-1")
        #expect(metadata.filename == "shot.jpg")
        #expect(metadata.mimeType == "image/jpeg")
        #expect(metadata.size == 3)
        #expect(metadata.path == "/uploads/shot.jpg")
        #expect(metadata.previewUrl == AttachmentPolicy.dataUrl(mimeType: "image/jpeg", bytes: Data([9, 9])))
        #expect(harness.tray.items.isEmpty)
        #expect(harness.tray.consume() == nil)
    }

    @Test func uploadFailureSettlesFailedAndRetryReUploadsToReady() async throws {
        let harness = try TrayHarness()
        await harness.performer.scriptUpload(status: 500, json: #"{"error":"boom"}"#)

        harness.tray.add(prepared())
        #expect(await eventually {
            harness.tray.items.count == 1 && harness.tray.items[0].status == .failed
        })
        #expect(harness.tray.hasUnsettled)

        harness.tray.retry("att-1")
        #expect(await eventually {
            harness.tray.items.count == 1 && harness.tray.items[0].status == .ready
        })
        let uploads = await harness.performer.bodies(pathSuffix: "/upload")
        #expect(uploads.count == 2)
        #expect(uploads[0] == uploads[1])
    }

    @Test func successFalseResponsesSettleFailedToo() async throws {
        let harness = try TrayHarness()
        await harness.performer.scriptUpload(json: #"{"success":false,"error":"disk full"}"#)

        harness.tray.add(prepared())

        #expect(await eventually {
            harness.tray.items.count == 1 && harness.tray.items[0].status == .failed
        })
    }

    @Test func removingAReadyChipDeletesTheHubUploadBestEffort() async throws {
        let harness = try TrayHarness()
        harness.tray.add(prepared())
        #expect(await eventually {
            harness.tray.items.count == 1 && harness.tray.items[0].status == .ready
        })

        harness.tray.remove("att-1")

        #expect(harness.tray.items.isEmpty)
        #expect(await eventually {
            await harness.performer.bodies(pathSuffix: "/upload/delete") == [#"{"path":"/uploads/shot.jpg"}"#]
        })
    }

    @Test func removingAChipMidUploadDeletesTheOrphanOnceTheUploadLands() async throws {
        let harness = try TrayHarness()
        await harness.performer.gateUploads()

        harness.tray.add(prepared())
        // Upload started and parked on the gate.
        #expect(await eventually {
            await harness.performer.count(pathSuffix: "/upload") == 1
        })
        harness.tray.remove("att-1")
        #expect(harness.tray.items.isEmpty)
        await harness.performer.openGate()

        // The late-arriving path is deleted, and the chip never reappears.
        #expect(await eventually {
            await harness.performer.count(pathSuffix: "/upload/delete") == 1
        })
        #expect(harness.tray.items.isEmpty)
    }

    @Test func consumeTakesOnlyReadyChipsAndLeavesUnsettledOnesInTheTray() async throws {
        let harness = try TrayHarness()
        await harness.performer.scriptUpload(status: 500, json: #"{"error":"boom"}"#)
        harness.tray.add(prepared(id: "bad", filename: "bad.bin", mimeType: "application/octet-stream", previewBytes: nil))
        #expect(await eventually {
            harness.tray.items.contains { $0.id == "bad" && $0.status == .failed }
        })
        harness.tray.add(prepared(id: "good", filename: "good.jpg"))
        #expect(await eventually {
            harness.tray.items.contains { $0.id == "good" && $0.status == .ready }
        })

        let metadata = try #require(harness.tray.consume())

        #expect(metadata.map(\.id) == ["good"])
        #expect(harness.tray.items.map(\.id) == ["bad"])
    }

    @Test func discardAllDetachedDeletesEveryUploadedPathAndEmptiesTheTray() async throws {
        let harness = try TrayHarness()
        harness.tray.add(prepared(id: "a", filename: "a.jpg"))
        harness.tray.add(prepared(id: "b", filename: "b.jpg"))
        #expect(await eventually {
            harness.tray.items.count == 2 && harness.tray.allReady
        })

        harness.tray.discardAllDetached()

        #expect(harness.tray.items.isEmpty)
        #expect(await eventually {
            let deletes = await harness.performer.bodies(pathSuffix: "/upload/delete")
            return Set(deletes) == Set([
                #"{"path":"/uploads/a.jpg"}"#,
                #"{"path":"/uploads/b.jpg"}"#,
            ])
        })
    }
}
