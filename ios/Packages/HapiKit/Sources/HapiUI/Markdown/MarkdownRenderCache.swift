import Foundation
import SwiftUI

/// Per-chat bounded cache. Synchronous lookup avoids an actor-hop placeholder
/// when a cell is recycled; preparation runs off the main thread.
public final class MarkdownRenderCache: @unchecked Sendable {
    private struct Entry {
        let blocks: [MarkdownBlockNode]
        let cost: Int
        var accessed: Int
    }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var clock = 0
    private var totalCost = 0
    private let maxCost: Int

    public init(maxCost: Int = 8 * 1024 * 1024) { self.maxCost = maxCost }

    public func cached(_ text: String) -> [MarkdownBlockNode]? {
        lock.withLock {
            guard var entry = entries[text] else { return nil }
            clock += 1
            entry.accessed = clock
            entries[text] = entry
            return entry.blocks
        }
    }

    public func prepare(_ sources: [String]) async {
        let task = Task.detached(priority: .userInitiated) { [self] in
            for text in Set(sources) where cached(text) == nil {
                guard !Task.isCancelled else { return }
                guard text.utf8.count * 4 <= maxCost else { continue }
                let blocks = MarkdownBlockTree.build(from: text)
                lock.withLock {
                    guard entries[text] == nil else { return }
                    clock += 1
                    let cost = max(1, text.utf8.count * 4)
                    guard cost <= maxCost else { return }
                    entries[text] = Entry(blocks: blocks, cost: cost, accessed: clock)
                    totalCost += cost
                    while totalCost > maxCost || entries.count > 800 {
                        guard let oldest = entries.min(by: { $0.value.accessed < $1.value.accessed }) else { break }
                        totalCost -= oldest.value.cost
                        entries.removeValue(forKey: oldest.key)
                    }
                }
            }
        }
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }
}

private struct MarkdownRenderCacheKey: EnvironmentKey {
    static let defaultValue: MarkdownRenderCache? = nil
}

public extension EnvironmentValues {
    var hapiMarkdownCache: MarkdownRenderCache? {
        get { self[MarkdownRenderCacheKey.self] }
        set { self[MarkdownRenderCacheKey.self] = newValue }
    }
}

/// Normally prewarmed before publishing the chat snapshot. An on-demand
/// miss keeps previous content until the new revision has been parsed.
public struct CachedMarkdownView: View {
    public let markdown: String
    @Environment(\.hapiMarkdownCache) private var cache
    @State private var prepared: [MarkdownBlockNode]?

    public init(markdown: String) { self.markdown = markdown }

    public var body: some View {
        Group {
            if let cache {
                if let blocks = cache.cached(markdown) ?? prepared { MarkdownView(blocks: blocks) }
                else { Text(markdown).textSelection(.enabled) }
            } else {
                MarkdownView(markdown: markdown)
            }
        }
        .task(id: markdown) {
            guard let cache else { return }
            await cache.prepare([markdown])
            guard !Task.isCancelled else { return }
            if let blocks = cache.cached(markdown) { prepared = blocks }
            else {
                let source = markdown
                let blocks = await Task.detached { MarkdownBlockTree.build(from: source) }.value
                if !Task.isCancelled { prepared = blocks }
            }
        }
    }
}
