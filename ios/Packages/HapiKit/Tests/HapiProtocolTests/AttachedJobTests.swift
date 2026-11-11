import Foundation
import HapiProtocol
import Testing

/// tiann/hapi#1404 on the list row: wire decoding, the strict `>` version
/// gate of web `patchSessionSummary`, render relevance and the row helpers.
@Suite("Attached jobs")
struct AttachedJobTests {
    private let jobJSON = """
        {"key":"import","label":"Import","status":"running","done":12,"total":30,"unit":"files",\
        "runId":"r1","wakeOnTerminal":true,"heartbeatAt":5000,"startedAt":1000,"updatedAt":5000}
        """

    private func summary() -> SessionSummary {
        SessionSummary(id: "s1", active: false, thinking: false, activeAt: 0, updatedAt: 0,
                       metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, pendingRequestsCount: 0)
    }

    private func patch(_ json: String) throws -> SessionPatch {
        try JSONDecoder().decode(SessionPatch.self, from: Data(json.utf8))
    }

    @Test func listRowsDecodeJobsLeniently() throws {
        let row = """
            {"id":"s1","active":false,"thinking":false,"activeAt":0,"updatedAt":0,"metadataVersion":0,\
            "agentStateVersion":0,"todosUpdatedAt":0,"pendingRequestsCount":0,"pendingRequestKinds":[],\
            "pendingRequests":[],"backgroundTaskCount":0,"futureScheduledMessageCount":0,\
            "attachedJob":\(jobJSON),"attachedJobUpdatedAt":7}
            """
        let decoded = try JSONDecoder().decode(SessionSummary.self, from: Data(row.utf8))
        #expect(decoded.attachedJob?.label == "Import")
        #expect(decoded.attachedJob?.isRunning == true)
        #expect(decoded.attachedJobUpdatedAt == 7)

        let unknownStatus = row.replacingOccurrences(of: "\"running\"", with: "\"paused\"")
        let paused = try JSONDecoder().decode(SessionSummary.self, from: Data(unknownStatus.utf8))
        #expect(paused.attachedJob?.isRunning == false, "A new status must not fail the list")

        let legacy = row.replacingOccurrences(of: ",\"attachedJob\":\(jobJSON),\"attachedJobUpdatedAt\":7", with: "")
        let old = try JSONDecoder().decode(SessionSummary.self, from: Data(legacy.utf8))
        #expect(old.attachedJob == nil && old.attachedJobUpdatedAt == nil)
    }

    @Test func patchesApplyOnlyWhenStrictlyNewer() throws {
        let start = try patch("{\"attachedJob\":{\"version\":5,\"value\":\(jobJSON)}}")
        let running = SummaryPatching.applySessionSummaryPatch(summary(), start)
        #expect(running.attachedJob?.done == 12)
        #expect(running.attachedJobUpdatedAt == 5)
        #expect(!SummaryPatching.isRenderIrrelevantPatch(current: summary(), next: running))

        let cleared = SummaryPatching.applySessionSummaryPatch(
            running, try patch("{\"attachedJob\":{\"version\":6,\"value\":null}}"))
        #expect(cleared.attachedJob == nil)
        #expect(cleared.attachedJobUpdatedAt == 6)

        // Dual SSE: a lagged heartbeat cannot resurrect the clear, and an
        // equal version is a replay.
        #expect(SummaryPatching.applySessionSummaryPatch(cleared, start).attachedJob == nil)
        var heartbeat = try #require(running.attachedJob)
        heartbeat.heartbeatAt = 9000
        let replay = SessionPatch(attachedJob: VersionedValue(version: 5, value: heartbeat))
        #expect(SummaryPatching.applySessionSummaryPatch(running, replay) == running)
        let beat = SummaryPatching.applySessionSummaryPatch(
            running, SessionPatch(attachedJob: VersionedValue(version: 7, value: heartbeat)))
        #expect(!SummaryPatching.isRenderIrrelevantPatch(current: running, next: beat), "Heartbeats drive staleness")
    }

    @Test func rowHelpersMatchTheWebLabels() {
        var job = AttachedJob(key: "k", label: "Import", done: 12, total: 30, heartbeatAt: 0, startedAt: 0, updatedAt: 0)
        #expect(job.percent == 40)
        job.done = 45
        #expect(job.percent == 100, "Capped")
        job.total = nil
        #expect(job.percent == nil)
        #expect(!job.isStale(nowMs: AttachedJob.staleAfterMs))
        #expect(job.isStale(nowMs: AttachedJob.staleAfterMs + 1))

        #expect(formatCompactElapsed(ms: 59_999) == "<1m")
        #expect(formatCompactElapsed(ms: 5 * 60_000) == "5m")
        #expect(formatCompactElapsed(ms: 3 * 3_600_000 + 5 * 60_000) == "3h 5m")
        #expect(formatCompactElapsed(ms: 2 * 3_600_000) == "2h")
        #expect(formatCompactElapsed(ms: 26 * 3_600_000) == "1d 2h")
        #expect(formatJobQuantity(12) == "12")
        #expect(formatJobQuantity(1.5) == "1.5")
    }
}
