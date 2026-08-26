import Foundation
import HapiClient
import Testing

/// Transcribes the Android reference suite (`JsonSnapshotStoreTest.kt`):
/// load semantics, the debounce window, and atomic replacement.
@MainActor
@Suite("DiskCache")
struct DiskCacheTests {

    private func makeCache(
        _ directory: URL,
        filename: String,
        debounce: Duration = .milliseconds(500)
    ) -> DiskCache<[String]> {
        DiskCache<[String]>(directory: directory, filename: filename, debounce: debounce)
    }

    @Test func loadReturnsNilForAMissingFile() {
        #expect(makeCache(makeTempDirectory(), filename: "missing.json").load() == nil)
    }

    @Test func loadReturnsNilForACorruptFile() throws {
        let directory = makeTempDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: directory.appendingPathComponent("corrupt.json"))
        #expect(makeCache(directory, filename: "corrupt.json").load() == nil)
    }

    @Test func writeRoundTripsThroughAFreshCache() async {
        let directory = makeTempDirectory()
        let writer = makeCache(directory, filename: "data.json")
        writer.scheduleWrite(["a", "b"])
        await writer.flush()
        #expect(makeCache(directory, filename: "data.json").load() == ["a", "b"])
    }

    @Test func debounceDelaysTheWriteAndKeepsOnlyTheLatestValue() async throws {
        let directory = makeTempDirectory()
        // A debounce far beyond the test's runtime: only flush() may write.
        let writer = makeCache(directory, filename: "debounced.json", debounce: .seconds(60))
        let file = directory.appendingPathComponent("debounced.json")

        writer.scheduleWrite(["v1"])
        try await Task.sleep(for: .milliseconds(50))
        #expect(!FileManager.default.fileExists(atPath: file.path), "write must wait for the debounce window")

        // A newer value restarts the window and supersedes v1.
        writer.scheduleWrite(["v2"])
        try await Task.sleep(for: .milliseconds(50))
        #expect(!FileManager.default.fileExists(atPath: file.path))

        await writer.flush()
        #expect(makeCache(directory, filename: "debounced.json").load() == ["v2"])
    }

    @Test func flushAfterTheDebouncedWriteAlreadyLandedIsANoOp() async throws {
        let directory = makeTempDirectory()
        let writer = makeCache(directory, filename: "settled.json")
        let file = directory.appendingPathComponent("settled.json")
        writer.scheduleWrite(["v1"])
        await writer.flush()
        #expect(makeCache(directory, filename: "settled.json").load() == ["v1"])
        try FileManager.default.removeItem(at: file)
        await writer.flush() // nothing pending → must not resurrect the file
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func writeReplacesPreviousContentAtomicallyWithoutTempResidue() async throws {
        let directory = makeTempDirectory()
        let writer = makeCache(directory, filename: "atomic.json")
        writer.scheduleWrite(["first"])
        await writer.flush()
        writer.scheduleWrite(["second"])
        await writer.flush()
        #expect(makeCache(directory, filename: "atomic.json").load() == ["second"])
        let residue = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0 != "atomic.json" }
        #expect(residue.isEmpty, "atomic write must leave no temp files behind")
    }
}
