import Foundation
import Testing
@testable import HapiProtocol

/// Regression: `fs.stat`-derived epoch fields arrive **fractional** from real
/// hubs (`"startedCliMtimeMs":1786932205158.1177` observed in a live DB); an
/// integer-typed decode threw and took the whole machines/files response down.
@Suite struct LenientEpochMsTests {
    private let decoder = JSONDecoder()

    @Test func machineMetadataDecodesFractionalCliMtimes() throws {
        let json = """
        {"id":"m1","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,
         "active":true,"activeAt":3,"metadataVersion":1,"runnerStateVersion":0,
         "metadata":{"host":"h","platform":"linux","happyCliVersion":"0.28.0",
                     "startedCliMtimeMs":1786932205158.1177,
                     "installedCliMtimeMs":1786501585709.12}}
        """
        let machine = try decoder.decode(Machine.self, from: Data(json.utf8))
        #expect(machine.metadata?.startedCliMtimeMs.map { Int64($0) } == 1786932205158)
        #expect(machine.metadata?.installedCliMtimeMs.map { Int64($0) } == 1786501585709)
    }

    @Test func fileEntriesDecodeFractionalModified() throws {
        let read = try decoder.decode(
            FileReadResponse.self,
            from: Data(#"{"success":true,"content":"aGk=","size":2,"modified":1786932205158.0001}"#.utf8)
        )
        #expect(read.modified.map { Int64($0) } == 1786932205158)

        let entry = try decoder.decode(
            DirectoryEntry.self,
            from: Data(#"{"name":"src","type":"directory","modified":1786932205158.9}"#.utf8)
        )
        #expect(entry.modified.map { Int64($0) } == 1786932205158)
    }
}
