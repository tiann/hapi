import Foundation
import HapiProtocol
import Testing

/// Decoding tests for the `SyncEvent` union against the wire shapes in
/// `docs/api/client-contract/sse.md` and `SyncEventSchema`
/// (`shared/src/schemas.ts`).
@Suite("SyncEvent wire decoding")
struct SyncEventDecodingTests {
    private func decode(_ json: String) throws -> SyncEvent {
        try JSONDecoder().decode(SyncEvent.self, from: Data(json.utf8))
    }

    @Test func decodesSessionUpdatedPatch() throws {
        let event = try decode("""
        {
            "type": "session-updated",
            "namespace": "default",
            "sessionId": "s-1",
            "data": {
                "active": true,
                "activeAt": 123,
                "updatedAt": 456,
                "serviceTier": null,
                "metadata": {"version": 7, "value": null}
            }
        }
        """)
        guard case .sessionUpdated(let namespace, let sessionId, .patch(let patch)?) = event else {
            Issue.record("expected .sessionUpdated with .patch, got \(event)")
            return
        }
        #expect(namespace == "default")
        #expect(sessionId == "s-1")
        #expect(patch.active == true)
        #expect(patch.activeAt == 123)
        #expect(patch.updatedAt == 456)
        // Explicit null is preserved as .null, distinct from an absent key.
        #expect(patch.serviceTier == .null)
        #expect(patch.model == nil)
        #expect(patch.metadata == VersionedValue<SessionMetadata>(version: 7, value: nil))
    }

    @Test func decodesSessionUpdatedFullSession() throws {
        let event = try decode("""
        {
            "type": "session-updated",
            "sessionId": "s-1",
            "data": {
                "id": "s-1",
                "namespace": "default",
                "seq": 12,
                "createdAt": 1000,
                "updatedAt": 2000,
                "active": true,
                "activeAt": null,
                "metadata": {"path": "/repo", "host": "mbp", "flavor": "claude", "codexSessionId": "ignored-unknown-field"},
                "metadataVersion": 3,
                "agentState": null,
                "agentStateVersion": 0,
                "thinking": false,
                "thinkingAt": 0,
                "permissionMode": "acceptEdits",
                "copilotAgentMode": "fleet"
            }
        }
        """)
        guard case .sessionUpdated(_, _, .session(let session)?) = event else {
            Issue.record("expected .sessionUpdated with .session, got \(event)")
            return
        }
        #expect(session.id == "s-1")
        #expect(session.seq == 12)
        // zod nullish transform: null activeAt becomes 0.
        #expect(session.activeAt == 0)
        #expect(session.metadata?.path == "/repo")
        #expect(session.metadata?.flavor == "claude")
        #expect(session.metadataVersion == 3)
        #expect(session.permissionMode == .acceptEdits)
        // Legacy fleet coerces to interactive (CopilotAgentModeSchema).
        #expect(session.copilotAgentMode == .interactive)
        #expect(session.model == nil)
    }

    @Test func unknownPatchKeysFallBackToUnrecognized() throws {
        // SessionPatchSchema is strict; a payload that is neither a full
        // Session nor a known-keys-only patch must surface as unrecognized
        // (the caller then refetches, like the web client on a zod failure).
        let event = try decode("""
        {
            "type": "session-updated",
            "sessionId": "s-1",
            "data": {"activeAt": 1, "someFutureField": 2}
        }
        """)
        guard case .sessionUpdated(_, _, .unrecognized(let raw)?) = event else {
            Issue.record("expected .unrecognized, got \(event)")
            return
        }
        #expect(raw == ["activeAt": 1, "someFutureField": 2])
    }

    @Test func decodesSessionAddedLikeSessionUpdated() throws {
        let event = try decode("""
        {"type": "session-added", "sessionId": "s-2", "data": {"thinking": true}}
        """)
        guard case .sessionAdded(_, "s-2", .patch(let patch)?) = event else {
            Issue.record("expected .sessionAdded patch, got \(event)")
            return
        }
        #expect(patch.thinking == true)
    }

    @Test func decodesSessionRemovedAndEnded() throws {
        let removed = try decode("""
        {"type": "session-removed", "namespace": "default", "sessionId": "s-3"}
        """)
        #expect(removed == .sessionRemoved(namespace: "default", sessionId: "s-3"))

        let ended = try decode("""
        {"type": "session-ended", "sessionId": "s-3", "reason": "completed"}
        """)
        #expect(ended == .sessionEnded(namespace: nil, sessionId: "s-3", reason: .completed))

        // Unknown reasons degrade to nil instead of throwing.
        let oddReason = try decode("""
        {"type": "session-ended", "sessionId": "s-3", "reason": "imploded"}
        """)
        #expect(oddReason == .sessionEnded(namespace: nil, sessionId: "s-3", reason: nil))
    }

    @Test func decodesMessageReceived() throws {
        let event = try decode("""
        {
            "type": "message-received",
            "namespace": "default",
            "sessionId": "s-1",
            "message": {
                "id": "m-1",
                "seq": 41,
                "localId": "local-1",
                "content": {"role": "user", "content": {"type": "text", "text": "hi"}},
                "createdAt": 1755000000000,
                "invokedAt": null
            }
        }
        """)
        guard case .messageReceived(_, "s-1", let message) = event else {
            Issue.record("expected .messageReceived, got \(event)")
            return
        }
        #expect(message.id == "m-1")
        #expect(message.seq == 41)
        #expect(message.localId == "local-1")
        #expect(message.createdAt == 1_755_000_000_000)
        #expect(message.invokedAt == nil)
    }

    @Test func decodesQueueLifecycleEvents() throws {
        let consumed = try decode("""
        {"type": "messages-consumed", "sessionId": "s-1", "localIds": ["a", "b"], "invokedAt": 99}
        """)
        #expect(consumed == .messagesConsumed(namespace: nil, sessionId: "s-1", localIds: ["a", "b"], invokedAt: 99))

        let cancelled = try decode("""
        {"type": "message-cancelled", "sessionId": "s-1", "messageId": "m-9"}
        """)
        #expect(cancelled == .messageCancelled(namespace: nil, sessionId: "s-1", messageId: "m-9", localId: nil))

        let invalidated = try decode("""
        {"type": "messages-invalidated", "sessionId": "s-1"}
        """)
        #expect(invalidated == .messagesInvalidated(namespace: nil, sessionId: "s-1"))

        let matured = try decode("""
        {"type": "scheduled-matured", "sessionId": "s-1"}
        """)
        #expect(matured == .scheduledMatured(namespace: nil, sessionId: "s-1"))
    }

    @Test func decodesHeartbeatWithAndWithoutData() throws {
        let full = try decode("""
        {"type": "heartbeat", "namespace": "default", "data": {"timestamp": 1755000000000}}
        """)
        #expect(full == .heartbeat(namespace: "default", timestamp: 1_755_000_000_000))

        let bare = try decode("""
        {"type": "heartbeat"}
        """)
        #expect(bare == .heartbeat(namespace: nil, timestamp: nil))
    }

    @Test func decodesConnectionChangedHandshake() throws {
        let ok = try decode("""
        {"type": "connection-changed", "data": {"status": "connected", "subscriptionId": "sub-1", "resume": "ok"}}
        """)
        guard case .connectionChanged(_, let payload?) = ok else {
            Issue.record("expected payload, got \(ok)")
            return
        }
        #expect(payload.status == "connected")
        #expect(payload.subscriptionId == "sub-1")
        #expect(payload.resume == .ok)

        // Unknown resume verdicts degrade to nil (treat as gap).
        let odd = try decode("""
        {"type": "connection-changed", "data": {"status": "connected", "resume": "sideways"}}
        """)
        guard case .connectionChanged(_, let oddPayload?) = odd else {
            Issue.record("expected payload, got \(odd)")
            return
        }
        #expect(oddPayload.resume == nil)
    }

    @Test func decodesToast() throws {
        let event = try decode("""
        {"type": "toast", "namespace": "default", "data": {"title": "Ready", "body": "Session done", "sessionId": "s-1", "url": "/sessions/s-1"}}
        """)
        #expect(event == .toast(
            namespace: "default",
            data: ToastPayload(title: "Ready", body: "Session done", sessionId: "s-1", url: "/sessions/s-1")
        ))
    }

    @Test func decodesMachineUpdatedVariants() throws {
        let removed = try decode("""
        {"type": "machine-updated", "machineId": "mac-1", "data": null}
        """)
        #expect(removed == .machineUpdated(namespace: nil, machineId: "mac-1", data: .removed))

        let absent = try decode("""
        {"type": "machine-updated", "machineId": "mac-1"}
        """)
        #expect(absent == .machineUpdated(namespace: nil, machineId: "mac-1", data: nil))

        let patch = try decode("""
        {"type": "machine-updated", "machineId": "mac-1", "data": {"active": false, "activeAt": 5}}
        """)
        #expect(patch == .machineUpdated(
            namespace: nil,
            machineId: "mac-1",
            data: .patch(MachinePatch(active: false, activeAt: 5))
        ))

        let full = try decode("""
        {
            "type": "machine-updated",
            "machineId": "mac-1",
            "data": {
                "id": "mac-1",
                "namespace": "default",
                "seq": 2,
                "createdAt": 1,
                "updatedAt": 2,
                "active": true,
                "activeAt": 3,
                "metadata": {"host": "mbp", "platform": "darwin", "happyCliVersion": "0.28.0"},
                "metadataVersion": 1,
                "runnerState": {"status": "running", "pid": 42},
                "runnerStateVersion": 1
            }
        }
        """)
        guard case .machineUpdated(_, _, .machine(let machine)?) = full else {
            Issue.record("expected .machine, got \(full)")
            return
        }
        #expect(machine.id == "mac-1")
        #expect(machine.metadata?.platform == "darwin")
        #expect(machine.runnerState?.isRunning == true)
        #expect(machine.runnerState?.pid == 42)
        #expect(machine.health == nil)
    }

    @Test func unknownEventTypesNeverThrow() throws {
        let event = try decode("""
        {"type": "hologram-sync", "namespace": "default", "hologramId": "h-1"}
        """)
        #expect(event == .unknown(type: "hologram-sync", namespace: "default"))
    }
}
