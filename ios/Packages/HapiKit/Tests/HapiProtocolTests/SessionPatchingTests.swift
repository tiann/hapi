import Foundation
import HapiProtocol
import Testing

/// Ports the version-gate and detail-patch cases from
/// `web/src/hooks/useSSE.test.ts` (backed by `web/src/lib/sessionPatch.ts`).
@Suite("Session patching")
struct SessionPatchingTests {
    private func makeSession(
        updatedAt: Int = 2_000,
        active: Bool = true,
        activeAt: Int = 1_000,
        metadata: SessionMetadata? = nil,
        metadataVersion: Int = 1,
        agentState: AgentState? = nil,
        agentStateVersion: Int = 1,
        thinking: Bool = false,
        todos: [TodoItem]? = nil,
        teamState: JSONValue? = nil,
        todosUpdatedAt: Int? = 0,
        teamStateUpdatedAt: Int? = 0,
        model: String? = "gpt-5",
        serviceTier: String? = nil,
        permissionMode: PermissionMode? = .default,
        copilotAgentMode: CopilotAgentMode? = .interactive
    ) -> Session {
        Session(
            id: "session-1",
            namespace: "default",
            seq: 1,
            createdAt: 1_000,
            updatedAt: updatedAt,
            active: active,
            activeAt: activeAt,
            metadata: metadata,
            metadataVersion: metadataVersion,
            agentState: agentState,
            agentStateVersion: agentStateVersion,
            thinking: thinking,
            thinkingAt: 0,
            todos: todos,
            teamState: teamState,
            todosUpdatedAt: todosUpdatedAt,
            teamStateUpdatedAt: teamStateUpdatedAt,
            model: model,
            serviceTier: serviceTier,
            permissionMode: permissionMode,
            copilotAgentMode: copilotAgentMode
        )
    }

    // MARK: - isNewerVersionedPatch (useSSE.test.ts "isNewerVersionedPatch")

    @Test func acceptsStrictlyNewerPatch() {
        #expect(isNewerVersionedPatch(patchVersion: 5, cachedVersion: 4))
    }

    @Test func rejectsOlderPatch() {
        // The bug case: stale buffered patch replayed on reconnect.
        #expect(!isNewerVersionedPatch(patchVersion: 4, cachedVersion: 5))
    }

    @Test func rejectsSameVersionPatch() {
        // Idempotent / duplicate replay.
        #expect(!isNewerVersionedPatch(patchVersion: 5, cachedVersion: 5))
    }

    @Test func acceptsFirstWriteIntoFreshCache() {
        #expect(isNewerVersionedPatch(patchVersion: 1, cachedVersion: 0))
    }

    // MARK: - applySessionDetailPatch (useSSE.test.ts "Copilot keep-alive")

    @Test func appliesCopilotAgentModeKeepAliveChange() throws {
        let session = makeSession()
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: .plan
        )))
        #expect(next.copilotAgentMode == .plan)
        #expect(next.activeAt == 11_000)
    }

    @Test func returnsNilForKeepAliveRepeatingCurrentCopilotMode() {
        let session = makeSession()
        let next = applySessionDetailPatch(session: session, patch: SessionPatch(
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: .interactive
        ))
        #expect(next == nil)
    }

    // MARK: - Version gates

    @Test func dropsStaleMetadataPatch() {
        let session = makeSession(metadataVersion: 5)
        let next = applySessionDetailPatch(session: session, patch: SessionPatch(
            metadata: VersionedValue(version: 4, value: SessionMetadata(path: "/new", host: "h"))
        ))
        // Wrapper presence is render-relevant, but the gate rejects it and
        // nothing else changed — so the reference returns null.
        #expect(next == nil)
    }

    @Test func dropsSameVersionMetadataPatch() {
        let session = makeSession(metadataVersion: 5)
        let next = applySessionDetailPatch(session: session, patch: SessionPatch(
            metadata: VersionedValue(version: 5, value: SessionMetadata(path: "/new", host: "h"))
        ))
        #expect(next == nil)
    }

    @Test func appliesStrictlyNewerMetadataPatch() throws {
        let session = makeSession(metadataVersion: 5)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            metadata: VersionedValue(version: 6, value: SessionMetadata(path: "/new", host: "h"))
        )))
        #expect(next.metadata?.path == "/new")
        #expect(next.metadataVersion == 6)
    }

    @Test func appliesFirstMetadataWriteIntoVersionZero() throws {
        let session = makeSession(metadataVersion: 0)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            metadata: VersionedValue(version: 1, value: SessionMetadata(path: "/p", host: "h"))
        )))
        #expect(next.metadataVersion == 1)
        #expect(next.metadata?.host == "h")
    }

    @Test func dropsStaleAgentStatePatchButAppliesNewer() throws {
        let pending = AgentState(requests: [
            "req-1": AgentStateRequest(tool: "Bash", createdAt: 1_000),
        ])
        let session = makeSession(agentState: pending, agentStateVersion: 3)

        let stale = applySessionDetailPatch(session: session, patch: SessionPatch(
            agentState: VersionedValue(version: 2, value: AgentState())
        ))
        #expect(stale == nil)

        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            agentState: VersionedValue(version: 4, value: AgentState())
        )))
        #expect(next.agentState?.requests == nil)
        #expect(next.agentStateVersion == 4)
    }

    @Test func gatesTodosOnTodosUpdatedAtWatermark() throws {
        let item = TodoItem(content: "port models", status: .inProgress, id: "t1")
        let session = makeSession(todosUpdatedAt: 5)

        #expect(applySessionDetailPatch(session: session, patch: SessionPatch(
            todos: VersionedValue(version: 5, value: [item])
        )) == nil)

        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            todos: VersionedValue(version: 6, value: [item])
        )))
        #expect(next.todos == [item])
        #expect(next.todosUpdatedAt == 6)
    }

    @Test func treatsAbsentTodosWatermarkAsZero() throws {
        let item = TodoItem(content: "x", status: .pending)
        let session = makeSession(todosUpdatedAt: nil)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            todos: VersionedValue(version: 1, value: [item])
        )))
        #expect(next.todos == [item])
        #expect(next.todosUpdatedAt == 1)
    }

    @Test func clearsTeamStateOnNullValueUnderNewerVersion() throws {
        let session = makeSession(teamState: ["teamName": "alpha"], teamStateUpdatedAt: 1)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            teamState: VersionedValue(version: 2, value: nil)
        )))
        #expect(next.teamState == nil)
        #expect(next.teamStateUpdatedAt == 2)
    }

    // MARK: - updatedAt monotonicity

    @Test func neverRewindsUpdatedAt() throws {
        let session = makeSession(updatedAt: 2_000)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            thinking: true,
            updatedAt: 1_500
        )))
        #expect(next.updatedAt == 2_000)
        #expect(next.thinking)
    }

    @Test func advancesUpdatedAtForward() throws {
        let session = makeSession(updatedAt: 2_000)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            updatedAt: 3_000
        )))
        #expect(next.updatedAt == 3_000)
    }

    @Test func staleUpdatedAtAloneIsANoOp() {
        // Relevant by strict compare, but max() keeps the cached stamp and
        // nothing else changes — the reference returns null.
        let session = makeSession(updatedAt: 2_000)
        #expect(applySessionDetailPatch(session: session, patch: SessionPatch(
            updatedAt: 1_500
        )) == nil)
    }

    // MARK: - Flat fields are unconditional

    @Test func appliesFlatFieldsEvenWhenVersionedPartIsStale() throws {
        let session = makeSession(metadataVersion: 5)
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            metadata: VersionedValue(version: 1, value: SessionMetadata(path: "/stale", host: "h")),
            model: .value("opus")
        )))
        #expect(next.model == "opus")
        #expect(next.metadata == nil)
        #expect(next.metadataVersion == 5)
    }

    @Test func explicitNullClearsServiceTier() throws {
        let session = makeSession(serviceTier: "fast")
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            serviceTier: .null
        )))
        #expect(next.serviceTier == nil)
    }

    @Test func absentServiceTierIsUntouched() throws {
        let session = makeSession(serviceTier: "fast")
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            thinking: true
        )))
        #expect(next.serviceTier == "fast")
    }

    // MARK: - Keep-alive irrelevance

    @Test func subMinuteActiveAtKeepAliveIsIrrelevant() {
        let session = makeSession(activeAt: 1_000)
        #expect(isRenderIrrelevantSessionPatch(session: session, patch: SessionPatch(
            active: true,
            thinking: false,
            activeAt: 11_000,
            model: .value("gpt-5"),
            permissionMode: .default
        )))
        #expect(applySessionDetailPatch(session: session, patch: SessionPatch(
            activeAt: 11_000
        )) == nil)
    }

    @Test func minuteActiveAtMoveIsRelevantAndApplied() throws {
        let session = makeSession(activeAt: 1_000)
        #expect(!isRenderIrrelevantSessionPatch(session: session, patch: SessionPatch(
            activeAt: 61_000
        )))
        let next = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            activeAt: 61_000
        )))
        #expect(next.activeAt == 61_000)
    }

    @Test func emptyPatchIsIrrelevant() {
        let session = makeSession()
        #expect(isRenderIrrelevantSessionPatch(session: session, patch: SessionPatch()))
        #expect(applySessionDetailPatch(session: session, patch: SessionPatch()) == nil)
    }

    // MARK: - Replicated TS surprises

    @Test func activeTurnStartedAtIsNeverApplied() throws {
        // web/src/lib/sessionPatch.ts carries the field on the patch type but
        // never assigns it; the port replicates that exactly.
        let session = makeSession()
        #expect(session.activeTurnStartedAt == nil)

        let alone = applySessionDetailPatch(session: session, patch: SessionPatch(
            activeTurnStartedAt: .value(5_000)
        ))
        #expect(alone == nil)

        let combined = try #require(applySessionDetailPatch(session: session, patch: SessionPatch(
            thinking: true,
            activeTurnStartedAt: .value(5_000)
        )))
        #expect(combined.thinking)
        #expect(combined.activeTurnStartedAt == nil)
    }

    @Test func scratchlistUpdatedAtIsARefetchTriggerOnly() {
        // Always render-relevant (Session has no such field), never applied.
        let session = makeSession()
        #expect(!isRenderIrrelevantSessionPatch(session: session, patch: SessionPatch(
            scratchlistUpdatedAt: 5_000
        )))
        #expect(applySessionDetailPatch(session: session, patch: SessionPatch(
            scratchlistUpdatedAt: 5_000
        )) == nil)
    }
}
