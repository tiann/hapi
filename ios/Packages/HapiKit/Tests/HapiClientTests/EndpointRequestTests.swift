import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

private let emptyPageJSON = """
{"messages":[],"page":{"direction":"before","limit":200,"epoch":0,"reset":false,\
"nextBeforeSeq":null,"nextBeforeAt":null,"nextAfterSeq":null,"nextAfterAt":null,\
"snapshotHeadSeq":null,"snapshotHeadAt":null,"hasMore":false}}
"""

@Suite("Endpoint request construction")
struct EndpointRequestTests {
    private func bodyString(_ request: URLRequest?) -> String? {
        request?.httpBody.flatMap { String(data: $0, encoding: .utf8) }
    }

    @Test func messagesPageWithBeforeCursor() async throws {
        let token = freshJWT()
        let harness = try makeHarness(jwt: token)
        await harness.performer.enqueue(json: emptyPageJSON)

        let response = try await harness.client.messages(
            sessionId: "s 1",
            query: .before(seq: 42, at: 170, limit: 200)
        )
        #expect(response.messages.isEmpty)
        #expect(response.page.direction == .before)

        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/s%201/messages?beforeAt=170&beforeSeq=42&limit=200"
        )
        #expect(request?.httpMethod == "GET")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
    }

    @Test func messagesPageWithAfterCursorAndEpoch() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: emptyPageJSON)

        _ = try await harness.client.messages(
            sessionId: "abc",
            query: .after(seq: 10, at: 99, epoch: 3)
        )
        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/messages?afterAt=99&afterSeq=10&epoch=3"
        )
    }

    @Test func sendMessageWithDeliveryMode() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"ok\":true}")

        try await harness.client.sendMessage(
            sessionId: "abc",
            text: "hi",
            localId: "L1",
            deliveryMode: .steer
        )
        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/sessions/abc/messages")
        #expect(request?.httpMethod == "POST")
        #expect(request?.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(bodyString(request) == "{\"deliveryMode\":\"steer\",\"localId\":\"L1\",\"text\":\"hi\"}")
    }

    @Test func approveWithNestedAnswers() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"ok\":true}")

        try await harness.client.approvePermission(
            sessionId: "abc",
            requestId: "r/1",
            PermissionApproveRequest(answers: ["q1": ["answers": ["a", "b"]]])
        )
        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/sessions/abc/permissions/r%2F1/approve"
        )
        #expect(bodyString(request) == "{\"answers\":{\"q1\":{\"answers\":[\"a\",\"b\"]}}}")
    }

    @Test func approveWithFlatAnswersAndModeSwitch() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"ok\":true}")

        try await harness.client.approvePermission(
            sessionId: "abc",
            requestId: "r1",
            PermissionApproveRequest(mode: .acceptEdits, answers: ["q1": ["a", "b"]])
        )
        let request = await harness.performer.requests.first
        #expect(
            bodyString(request)
                == "{\"answers\":{\"q1\":[\"a\",\"b\"]},\"mode\":\"acceptEdits\"}"
        )
    }

    @Test func setModelEncodesExplicitNull() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"ok\":true}")
        try await harness.client.setModel(sessionId: "abc", model: nil)
        let first = await harness.performer.requests.first
        #expect(bodyString(first) == "{\"model\":null}")

        await harness.performer.enqueue(json: "{\"ok\":true}")
        try await harness.client.setModel(
            sessionId: "abc",
            model: .catalogReference(provider: "openai", modelId: "gpt-5")
        )
        let second = await harness.performer.requests.last
        #expect(bodyString(second) == "{\"model\":{\"modelId\":\"gpt-5\",\"provider\":\"openai\"}}")
    }

    @Test func spawnDiscriminatesOnType() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"type\":\"success\",\"sessionId\":\"new-id\"}")
        let spawned = try await harness.client.spawnSession(
            machineId: "m1",
            SpawnRequest(directory: "/work/repo", agent: .claude, sessionType: .worktree, worktreeName: "wt")
        )
        #expect(spawned == .success(sessionId: "new-id"))
        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/machines/m1/spawn")
        #expect(
            bodyString(request)
                == "{\"agent\":\"claude\",\"directory\":\"/work/repo\",\"sessionType\":\"worktree\",\"worktreeName\":\"wt\"}"
        )

        await harness.performer.enqueue(json: "{\"type\":\"error\",\"message\":\"no runner\"}")
        let failed = try await harness.client.spawnSession(machineId: "m1", SpawnRequest(directory: "/x"))
        #expect(failed == .error(message: "no runner", code: nil, agent: nil))

        await harness.performer.enqueue(
            json: "{\"type\":\"error\",\"message\":\"Codex is not installed\","
                + "\"code\":\"agent_unavailable\",\"agent\":\"codex\"}"
        )
        let unavailable = try await harness.client.spawnSession(
            machineId: "m1",
            SpawnRequest(directory: "/x", agent: .codex)
        )
        #expect(
            unavailable == .error(
                message: "Codex is not installed",
                code: "agent_unavailable",
                agent: .codex
            )
        )
    }

    @Test func machineAvailabilityAndPathBoundaryResponses() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            json: "{\"agents\":[{\"agent\":\"claude\",\"available\":false,"
                + "\"reason\":\"not_found\"},{\"agent\":\"codex\",\"available\":true}]}"
        )
        let availability = try await harness.client.machineAgentAvailability(machineId: "m 1")
        #expect(availability.agents.map(\.agent) == [.claude, .codex])
        #expect(!availability.agents[0].available)
        #expect(availability.agents[0].reason == "not_found")
        let availabilityRequest = await harness.performer.requests.first
        #expect(
            availabilityRequest?.url?.absoluteString
                == "\(testHubURLString)/api/machines/m%201/agent-availability"
        )
        #expect(availabilityRequest?.httpMethod == "GET")

        await harness.performer.enqueue(
            json: "{\"exists\":{\"/workspace\":true,\"/outside\":false},"
                + "\"outsideWorkspaceRoots\":[\"/outside\"]}"
        )
        let paths = try await harness.client.machinePathsExist(
            machineId: "m1",
            paths: ["/workspace", "/outside"]
        )
        #expect(paths.exists["/workspace"] == true)
        #expect(paths.outsideWorkspaceRoots == ["/outside"])
        let pathRequest = await harness.performer.requests.last
        #expect(pathRequest?.url?.absoluteString == "\(testHubURLString)/api/machines/m1/paths/exists")
        #expect(bodyString(pathRequest) == "{\"paths\":[\"/workspace\",\"/outside\"]}")
    }

    @Test func machineCodexModelsRequestAndRpcTargetMissing() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            json: "{\"success\":true,\"models\":[{\"id\":\"gpt-5.2-codex\","
                + "\"displayName\":\"GPT-5.2 Codex\",\"isDefault\":true,"
                + "\"supportedReasoningEfforts\":[\"low\",\"medium\"],"
                + "\"serviceTiers\":[\"standard\",\"fast\"]}]}"
        )
        let response = try await harness.client.machineCodexModels(machineId: "m 1")
        #expect(response.success)
        #expect(response.models?.first?.id == "gpt-5.2-codex")
        #expect(response.models?.first?.serviceTiers == ["standard", "fast"])
        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/machines/m%201/codex-models"
        )
        #expect(request?.httpMethod == "GET")

        // Old runner without the machine RPC: 503 with the stable code the
        // new-session form keys off to hide the codex model picker.
        await harness.performer.enqueue(
            status: 503,
            json: "{\"success\":false,\"code\":\"rpc_target_missing\"}"
        )
        let error = await capturedError {
            try await harness.client.machineCodexModels(machineId: "m1")
        }
        #expect((error as? APIError)?.status == 503)
        #expect((error as? APIError)?.code == "rpc_target_missing")
    }

    @Test func transcriptionProvidersRequestsTheVoiceCatalog() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            json: "{\"providers\":[{\"id\":\"openai\",\"label\":\"OpenAI\","
                + "\"modes\":[\"standard\",\"realtime\"]},"
                + "{\"id\":\"browser-local\",\"label\":\"Browser on-device\","
                + "\"modes\":[\"realtime\"]}]}"
        )

        let response = try await harness.client.transcriptionProviders()

        #expect(response.providers.map(\.id) == ["openai", "browser-local"])
        #expect(response.providers.first?.modes == ["standard", "realtime"])
        #expect(response.providers.first?.label == "OpenAI")
        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/voice/transcription/providers"
        )
        #expect(request?.httpMethod == "GET")
    }

    @Test func transcribeVoicePostsMultipartFormData() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"text\":\"hello world\",\"language\":\"en\"}")

        let result = try await harness.client.transcribeVoice(
            audio: Data([1, 2, 3]),
            filename: "clip.m4a",
            mimeType: "audio/mp4",
            provider: "openai",
            language: "en-US"
        )

        #expect(result.text == "hello world")
        #expect(result.language == "en")
        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/voice/transcription")
        #expect(request?.httpMethod == "POST")
        let contentType = request?.value(forHTTPHeaderField: "Content-Type") ?? ""
        #expect(contentType.hasPrefix("multipart/form-data; boundary="))
        let raw = String(decoding: request?.httpBody ?? Data(), as: UTF8.self)
        // Android-parity part order: file, provider, mode, language.
        #expect(raw.contains(#"name="file"; filename="clip.m4a""#))
        #expect(raw.contains("Content-Type: audio/mp4"))
        #expect(raw.contains(#"name="provider""#) && raw.contains("openai"))
        #expect(raw.contains(#"name="mode""#) && raw.contains("standard"))
        #expect(raw.contains(#"name="language""#) && raw.contains("en-US"))
    }

    @Test func transcribeVoiceOmitsTheLanguagePartWhenNil() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"text\":\"ok\"}")

        _ = try await harness.client.transcribeVoice(
            audio: Data([9]),
            filename: "speech.m4a",
            mimeType: "audio/mp4",
            provider: "groq"
        )

        let request = await harness.performer.requests.first
        let raw = String(decoding: request?.httpBody ?? Data(), as: UTF8.self)
        #expect(!raw.contains(#"name="language""#))
        #expect(raw.contains(#"name="mode""#) && raw.contains("standard"))
    }
}
