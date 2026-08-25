import HapiClient
import Testing

@Suite("HapiClient scaffold")
struct SmokeTests {
    @Test func exposesVersionMetadata() {
        #expect(!HapiClientVersion.current.isEmpty)
        #expect(HapiClientVersion.protocolVersion == 1)
    }
}
