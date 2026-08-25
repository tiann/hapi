import Foundation
import HapiProtocol
import Testing

/// Port of the summary-path cases from `web/src/hooks/useSSE.test.ts`
/// (`canApplyVersionedSummaryPatch`, `isRenderIrrelevantPatch`) plus pins for
/// the pieces the web only exercises through the hook: the `>=` versioned
/// gates of `patchSessionSummary`, the `shared/src/sessionSummary.ts`
/// derivations, and the `toSessionSummary` projection. Transcribed from the
/// Android reference suite (`SummaryPatchingTest.kt`) case for case.
@Suite("Summary patching")
struct SummaryPatchingTests {

    private func makeSummary(
        id: String = "session-1",
        active: Bool = true,
        thinking: Bool = false,
        activeAt: Int = 1_000,
        updatedAt: Int = 2_000,
        pinned: Bool? = nil,
        globalPinned: Bool? = nil,
        metadata: SessionSummaryMetadata? = nil,
        metadataVersion: Int = 0,
        agentStateVersion: Int = 0,
        todosUpdatedAt: Int = 0,
        todoProgress: TodoProgress? = nil,
        pendingRequestsCount: Int = 0,
        pendingRequestKinds: [PendingRequestKind] = [],
        pendingRequests: [PendingRequest] = [],
        backgroundTaskCount: Int = 0,
        model: String? = nil,
        modelReasoningEffort: String? = nil,
        effort: String? = nil
    ) -> SessionSummary {
        SessionSummary(
            id: id,
            active: active,
            thinking: thinking,
            activeAt: activeAt,
            updatedAt: updatedAt,
            pinned: pinned,
            globalPinned: globalPinned,
            metadata: metadata,
            metadataVersion: metadataVersion,
            agentStateVersion: agentStateVersion,
            todosUpdatedAt: todosUpdatedAt,
            todoProgress: todoProgress,
            pendingRequestsCount: pendingRequestsCount,
            pendingRequestKinds: pendingRequestKinds,
            pendingRequests: pendingRequests,
            backgroundTaskCount: backgroundTaskCount,
            futureScheduledMessageCount: 0,
            nextScheduledAt: nil,
            model: model,
            modelReasoningEffort: modelReasoningEffort,
            effort: effort
        )
    }

    private func request(_ tool: String, createdAt: Int? = nil) -> AgentStateRequest {
        AgentStateRequest(tool: tool, arguments: .null, createdAt: createdAt)
    }

    // MARK: - Derivations

    @Test func pendingRequestKindsDedupeAndCanonicalizeBothKindsOrder() {
        #expect(SummaryPatching.computePendingRequestKinds(nil) == [])
        #expect(SummaryPatching.computePendingRequestKinds(AgentState()) == [])

        let permissionOnly = AgentState(requests: ["a": request("Bash"), "b": request("Edit")])
        #expect(SummaryPatching.computePendingRequestKinds(permissionOnly) == [.permission])

        let inputOnly = AgentState(requests: ["a": request("AskUserQuestion")])
        #expect(SummaryPatching.computePendingRequestKinds(inputOnly) == [.input])

        // Input encountered first — canonical order is still permission,input.
        let both = AgentState(requests: [
            "a": request("request_user_input"),
            "b": request("Bash"),
        ])
        #expect(SummaryPatching.computePendingRequestKinds(both) == [.permission, .input])
    }

    @Test func pendingRequestsSortOldestFirstWithIdTiebreakAndFallbackSince() {
        let state = AgentState(requests: [
            "req-c": request("Bash", createdAt: 300),
            "req-a": request("Edit", createdAt: nil), // → fallbackSince = 100
            "req-b": request("ExitPlanMode", createdAt: 100),
        ])
        let items = SummaryPatching.computePendingRequests(state, fallbackSince: 100)
        #expect(items.map(\.id) == ["req-a", "req-b", "req-c"])
        #expect(items.map(\.since) == [100, 100, 300])
        #expect(items.map(\.kind) == [.permission, .input, .permission])
    }

    @Test func pendingRequestsCapAtFiveButCountStaysAuthoritative() {
        var requests: [String: AgentStateRequest] = [:]
        for index in 1...7 {
            requests["req-\(index)"] = request("Bash", createdAt: index)
        }
        let state = AgentState(requests: requests)
        let items = SummaryPatching.computePendingRequests(state, fallbackSince: 0)
        #expect(items.count == 5)
        #expect(items.map(\.id) == (1...5).map { "req-\($0)" })
        #expect(SummaryPatching.computePendingRequestsCount(state) == 7)
    }

    @Test func todoProgressIsNilForAbsentOrEmptyAndCountsCompleted() {
        #expect(SummaryPatching.computeTodoProgress(nil) == nil)
        #expect(SummaryPatching.computeTodoProgress([]) == nil)
        let todos = [
            TodoItem(content: "a", status: .completed),
            TodoItem(content: "b", status: .inProgress),
            TodoItem(content: "c", status: .completed),
        ]
        #expect(SummaryPatching.computeTodoProgress(todos) == TodoProgress(completed: 2, total: 3))
    }

    // MARK: - Projection

    private func makeSession(
        metadata: SessionMetadata? = nil,
        agentState: AgentState? = nil,
        todos: [TodoItem]? = nil
    ) -> Session {
        Session(
            id: "session-1",
            namespace: "default",
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            active: true,
            activeAt: 1_000,
            metadata: metadata,
            metadataVersion: 3,
            agentState: agentState,
            agentStateVersion: 4,
            thinking: true,
            thinkingAt: 0,
            backgroundTaskCount: 2,
            todos: todos,
            todosUpdatedAt: 5,
            model: "opus",
            effort: "high"
        )
    }

    @Test func toSessionSummaryProjectsDerivedFieldsAndWatermarks() {
        let session = makeSession(
            metadata: SessionMetadata(
                path: "/repo",
                host: "host",
                name: "My session",
                summary: SessionMetadataSummary(text: "doing things", updatedAt: 9),
                flavor: "claude",
                claudeSessionId: " abc "
            ),
            agentState: AgentState(requests: ["r1": request("Bash", createdAt: 50)]),
            todos: [TodoItem(content: "a", status: .completed)]
        )
        let summary = SummaryPatching.toSessionSummary(session)
        #expect(summary.id == "session-1")
        #expect(summary.active)
        #expect(summary.thinking)
        #expect(summary.pinned == false)
        #expect(summary.globalPinned == false)
        #expect(summary.metadataVersion == 3)
        #expect(summary.agentStateVersion == 4)
        #expect(summary.todosUpdatedAt == 5)
        #expect(summary.todoProgress == TodoProgress(completed: 1, total: 1))
        #expect(summary.pendingRequestsCount == 1)
        #expect(summary.pendingRequestKinds == [.permission])
        #expect(summary.metadata?.agentSessionId == "abc") // trimmed
        #expect(summary.metadata?.summary?.text == "doing things")
        #expect(summary.backgroundTaskCount == 2)
        #expect(summary.futureScheduledMessageCount == 0)
        #expect(summary.nextScheduledAt == nil)
    }

    @Test func agentSessionIdUsesOnlyKnownFlavorFieldLegacyChainOtherwise() {
        // Known flavor: other flavors' ids are ignored, blank collapses to nil.
        let claude = SummaryPatching.toSessionSummaryMetadata(
            SessionMetadata(
                path: "/p", host: "h", flavor: "claude",
                claudeSessionId: "  ", codexSessionId: "cx"
            )
        )
        #expect(claude?.agentSessionId == nil)

        // Unknown flavor: legacy fallback chain, codex first, untrimmed.
        let unknown = SummaryPatching.toSessionSummaryMetadata(
            SessionMetadata(
                path: "/p", host: "h", flavor: "newagent",
                claudeSessionId: "cl", codexSessionId: "cx"
            )
        )
        #expect(unknown?.agentSessionId == "cx")

        // Legacy chain never reads piSessionId (replicated web quirk).
        let piOnly = SummaryPatching.toSessionSummaryMetadata(
            SessionMetadata(path: "/p", host: "h", flavor: nil, piSessionId: "pi-1")
        )
        #expect(piOnly?.agentSessionId == nil)
    }

    // MARK: - Patch application

    @Test func flatFieldsAreLastWriteWinsAndUpdatedAtIsMaxMonotonic() {
        let current = makeSummary(updatedAt: 2_000, backgroundTaskCount: 1, model: "opus")
        let next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(
                active: false,
                thinking: true,
                activeAt: 9_000,
                updatedAt: 1_500, // stale — must not rewind
                model: .null, // present null clears
                effort: .value("low"),
                backgroundTaskCount: 3
            )
        )
        #expect(!next.active)
        #expect(next.thinking)
        #expect(next.activeAt == 9_000)
        #expect(next.updatedAt == 2_000)
        #expect(next.model == nil)
        #expect(next.effort == "low")
        #expect(next.backgroundTaskCount == 3)
    }

    @Test func absentOptionalFieldsLeaveTheSummaryUntouched() {
        let current = makeSummary(model: "opus", modelReasoningEffort: "high", effort: "medium")
        let next = SummaryPatching.applySessionSummaryPatch(current, SessionPatch(activeAt: 5_000))
        #expect(next.model == "opus")
        #expect(next.modelReasoningEffort == "high")
        #expect(next.effort == "medium")
    }

    @Test func agentStatePatchWithEqualVersionReappliesSummaryPathAcceptsGte() {
        // DIVERGENCE FROM DETAIL PATH, replicated from web: the detail cache
        // gates with strict `>`; the summary path re-derives from `>=`
        // because the derivation is idempotent
        // (sse.md#versioned-patch-algorithm).
        let current = makeSummary(agentStateVersion: 5, pendingRequestsCount: 0)
        let state = AgentState(requests: ["r1": request("Bash", createdAt: 10)])
        let next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(agentState: VersionedValue(version: 5, value: state))
        )
        #expect(next.pendingRequestsCount == 1)
        #expect(next.pendingRequestKinds == [.permission])
        #expect(next.agentStateVersion == 5)
    }

    @Test func staleVersionedPatchesAreRejected() {
        let current = makeSummary(
            metadataVersion: 5,
            agentStateVersion: 5,
            todosUpdatedAt: 5,
            todoProgress: TodoProgress(completed: 1, total: 2),
            pendingRequestsCount: 2
        )
        let next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(
                metadata: VersionedValue(version: 4, value: SessionMetadata(path: "/new", host: "h")),
                agentState: VersionedValue(version: 4, value: AgentState()),
                todos: VersionedValue(version: 4, value: [])
            )
        )
        #expect(next.metadataVersion == 5)
        #expect(next.agentStateVersion == 5)
        #expect(next.todosUpdatedAt == 5)
        #expect(next.pendingRequestsCount == 2)
        #expect(next.todoProgress == TodoProgress(completed: 1, total: 2))
        #expect(next.metadata == nil)
    }

    @Test func newerVersionedPatchesRecomputeTheDerivedFields() {
        let current = makeSummary(updatedAt: 2_000, metadataVersion: 1, agentStateVersion: 1, todosUpdatedAt: 1)
        let next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(
                updatedAt: 8_000,
                metadata: VersionedValue(
                    version: 2,
                    value: SessionMetadata(path: "/repo", host: "h", name: "n")
                ),
                agentState: VersionedValue(
                    version: 2,
                    value: AgentState(requests: ["r1": request("Edit")])
                ),
                todos: VersionedValue(version: 2, value: [TodoItem(content: "a", status: .pending)])
            )
        )
        #expect(next.updatedAt == 8_000)
        #expect(next.metadataVersion == 2)
        #expect(next.metadata?.path == "/repo")
        #expect(next.agentStateVersion == 2)
        #expect(next.pendingRequestsCount == 1)
        // Requests without createdAt use the POST-patch updatedAt as `since`.
        #expect(next.pendingRequests.count == 1)
        #expect(next.pendingRequests.first?.since == 8_000)
        #expect(next.todosUpdatedAt == 2)
        #expect(next.todoProgress == TodoProgress(completed: 0, total: 1))
    }

    @Test func agentStateNullValueClearsThePendingFields() {
        let current = makeSummary(
            agentStateVersion: 1,
            pendingRequestsCount: 2,
            pendingRequestKinds: [.permission],
            pendingRequests: [PendingRequest(id: "r1", kind: .permission, tool: "Bash", since: 1)]
        )
        let next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(agentState: VersionedValue(version: 2, value: nil))
        )
        #expect(next.pendingRequestsCount == 0)
        #expect(next.pendingRequestKinds == [])
        #expect(next.pendingRequests == [])
    }

    @Test func teamStatePatchIsASummaryNoOp() {
        let current = makeSummary()
        let next = SummaryPatching.applySessionSummaryPatch(
            current,
            SessionPatch(teamState: VersionedValue(version: 9, value: nil))
        )
        #expect(next == current)
    }

    // MARK: - Render-irrelevance filter

    @Test func keepAliveThatOnlyMovesActiveAtIsIrrelevant() {
        let current = makeSummary(activeAt: 1_000)
        let next = makeSummary(activeAt: 11_000)
        #expect(SummaryPatching.isRenderIrrelevantPatch(current: current, next: next))
    }

    @Test func identicalSummariesAreIrrelevant() {
        #expect(SummaryPatching.isRenderIrrelevantPatch(current: makeSummary(), next: makeSummary()))
    }

    @Test func eachRenderedFieldChangeIsRelevant() {
        let cases: [SessionSummary] = [
            makeSummary(active: false),
            makeSummary(thinking: true),
            makeSummary(updatedAt: 9_999),
            makeSummary(backgroundTaskCount: 3),
            makeSummary(model: "opus"),
            makeSummary(modelReasoningEffort: "high"),
            makeSummary(effort: "medium"),
            makeSummary(pendingRequestsCount: 2),
            makeSummary(metadata: SessionSummaryMetadata(path: "/other")),
            makeSummary(metadata: SessionSummaryMetadata(path: "/tmp", flavor: "claude")),
            makeSummary(metadata: SessionSummaryMetadata(path: "/tmp", machineId: "Teemo")),
            makeSummary(
                metadata: SessionSummaryMetadata(
                    path: "/tmp",
                    worktree: WorktreeMetadata(
                        basePath: "/tmp", branch: "feat/x", name: "x", worktreePath: "/tmp/x"
                    )
                )
            ),
            makeSummary(todoProgress: TodoProgress(completed: 1, total: 2)),
            makeSummary(pendingRequestKinds: [.input]),
            makeSummary(metadataVersion: 7),
            makeSummary(agentStateVersion: 7),
            makeSummary(todosUpdatedAt: 7),
        ]
        for changed in cases {
            var next = changed
            next.activeAt = 11_000
            #expect(
                !SummaryPatching.isRenderIrrelevantPatch(current: makeSummary(), next: next),
                "expected relevant: \(changed)"
            )
        }
    }

    @Test func pendingRequestsCompareIdKindToolButNotSince() {
        let current = makeSummary(
            pendingRequests: [PendingRequest(id: "r1", kind: .permission, tool: "Bash", since: 1)]
        )
        let sinceOnly = makeSummary(
            pendingRequests: [PendingRequest(id: "r1", kind: .permission, tool: "Bash", since: 2)]
        )
        #expect(SummaryPatching.isRenderIrrelevantPatch(current: current, next: sinceOnly))

        let toolChanged = makeSummary(
            pendingRequests: [PendingRequest(id: "r1", kind: .permission, tool: "Edit", since: 1)]
        )
        #expect(!SummaryPatching.isRenderIrrelevantPatch(current: current, next: toolChanged))
    }

    // MARK: - Legacy detail-required gate

    @available(*, deprecated) // silences the deliberate use of the legacy gate
    @Test func canApplyVersionedSummaryPatchMirrorsTheLegacyRule() {
        // Non-versioned patches never need detail.
        #expect(SummaryPatching.canApplyVersionedSummaryPatch(patch: SessionPatch(), detailPresent: false))
        // metadata/agentState/todos each require detail.
        #expect(!SummaryPatching.canApplyVersionedSummaryPatch(
            patch: SessionPatch(metadata: VersionedValue(version: 1, value: nil)),
            detailPresent: false
        ))
        #expect(!SummaryPatching.canApplyVersionedSummaryPatch(
            patch: SessionPatch(agentState: VersionedValue(version: 1, value: nil)),
            detailPresent: false
        ))
        #expect(!SummaryPatching.canApplyVersionedSummaryPatch(
            patch: SessionPatch(todos: VersionedValue(version: 1, value: [])),
            detailPresent: false
        ))
        // teamState-only is a summary no-op and never blocks.
        #expect(SummaryPatching.canApplyVersionedSummaryPatch(
            patch: SessionPatch(teamState: VersionedValue(version: 1, value: nil)),
            detailPresent: false
        ))
        // With detail present everything is allowed.
        #expect(SummaryPatching.canApplyVersionedSummaryPatch(
            patch: SessionPatch(metadata: VersionedValue(version: 2, value: nil)),
            detailPresent: true
        ))
    }
}
