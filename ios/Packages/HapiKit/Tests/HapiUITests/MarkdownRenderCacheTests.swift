import HapiUI
import Testing

@Suite("Chat markdown cache")
struct MarkdownRenderCacheTests {
    @Test func prewarmingMatchesTheExistingRenderer() async {
        let cache = MarkdownRenderCache()
        let text = "## History\n\n```swift\nlet stable = true\n```"
        await cache.prepare([text])
        #expect(cache.cached(text) == MarkdownBlockTree.build(from: text))
        await cache.prepare([text])
        #expect(cache.cached(text) != nil)
    }

    @Test func retentionIsBoundedAndHugeEntriesDoNotEvictNormalOnes() async {
        let cache = MarkdownRenderCache(maxCost: 32)
        await cache.prepare(["one"])
        await cache.prepare([String(repeating: "x", count: 100)])
        #expect(cache.cached("one") != nil)
        await cache.prepare(["second"])
        #expect(cache.cached("one") == nil)
        #expect(cache.cached("second") != nil)
    }
}
