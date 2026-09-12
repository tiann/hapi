#if os(iOS)
import Observation
import SwiftUI
import UIKit
import os

public struct TranscriptViewport: Equatable {
    public let followsTail: Bool
    public let needsOlder: Bool
    public let isAtBottom: Bool
}

/// SwiftUI owns message content; UIKit owns scrolling, recycling and layout
/// transactions. In particular, a prepend never issues scrollToItem.
public struct AnchoredTranscriptList<Item: Identifiable & Equatable>: UIViewControllerRepresentable where Item.ID == String {
    public var items: [Item]
    public var historyVersion: Int
    public var jumpToken: Int
    public var historyControlID: String
    public var isInspectionPresented: Bool
    public var onViewport: (TranscriptViewport) -> Void
    public var onLayout: (Int, Bool) -> Void
    public var spacingBefore: (Item?, Item) -> CGFloat
    public var content: (Item) -> AnyView
    fileprivate var environment = EnvironmentValues()

    public init(items: [Item], historyVersion: Int, jumpToken: Int, historyControlID: String,
                isInspectionPresented: Bool = false,
                onViewport: @escaping (TranscriptViewport) -> Void,
                onLayout: @escaping (Int, Bool) -> Void,
                spacingBefore: @escaping (Item?, Item) -> CGFloat = { _, _ in 12 },
                content: @escaping (Item) -> AnyView) {
        self.items = items
        self.historyVersion = historyVersion
        self.jumpToken = jumpToken
        self.historyControlID = historyControlID
        self.isInspectionPresented = isInspectionPresented
        self.onViewport = onViewport
        self.onLayout = onLayout
        self.spacingBefore = spacingBefore
        self.content = content
    }

    public func makeUIViewController(context: Context) -> TranscriptCollectionController<Item> {
        TranscriptCollectionController()
    }

    public func updateUIViewController(_ controller: TranscriptCollectionController<Item>, context: Context) {
        var next = self
        next.environment = context.environment
        controller.update(next)
    }
}

struct ReadingAnchor {
    let id: String
    let offset: CGFloat
}

/// Stable-ID height estimates survive prepends and cell recycling. Unlike a
/// flow layout, offscreen measurements are not discarded on every snapshot.
/// Offset deltas participate in UIKit's layout, preserving an active pan/fling.
final class TranscriptLayout: UICollectionViewLayout {
    var anchorForUpdate: ReadingAnchor?
    var followsTail = true
    private var ids: [String] = []
    private var indicesByID: [String: Int] = [:]
    private var heights: [String: CGFloat] = [:]
    // Preserve enough estimated space for the current partial row to remain
    // visible while invalidated measurements are replaced. This is not a
    // cached measurement and must never be used to clamp a reading offset.
    private var anchorHeightEstimate: (id: String, height: CGFloat)?
    private var frames: [CGRect] = []
    private var attributes: [UICollectionViewLayoutAttributes?] = []
    private var width: CGFloat = 0
    private var spacingBefore: [CGFloat] = []
    private var contentHeight: CGFloat = 0
    private var dirtyFromIndex: Int? = 0
    #if DEBUG
    private(set) var attributeCreationCount = 0
    private(set) var visibleQueryProbeCount = 0
    #endif

    func setItems(_ ids: [String], width: CGFloat, spacingBefore: [CGFloat]? = nil,
                  invalidateMeasurements: Bool = false) {
        let spacing = spacingBefore ?? Array(repeating: CGFloat(12), count: ids.count)
        precondition(spacing.count == ids.count)
        let structureChanged = self.ids != ids
        guard structureChanged || self.width != width || self.spacingBefore != spacing || invalidateMeasurements else { return }
        if invalidateMeasurements || abs(HapiReadingLayout.contentWidth(in: self.width) - HapiReadingLayout.contentWidth(in: width)) > 0.5 {
            anchorHeightEstimate = anchorForUpdate.flatMap { anchor in
                guard let index = indicesByID[anchor.id], frames.indices.contains(index) else { return nil }
                return (anchor.id, max(frames[index].height, 1 - anchor.offset))
            }
            heights.removeAll()
        }
        self.width = width
        self.spacingBefore = spacing
        if structureChanged {
            self.ids = ids
            indicesByID.removeAll(keepingCapacity: true)
            for (index, id) in ids.enumerated() { indicesByID[id] = index }
            heights = heights.filter { indicesByID[$0.key] != nil }
            frames = Array(repeating: .zero, count: ids.count)
            attributes = Array(repeating: nil, count: ids.count)
        }
        dirtyFromIndex = 0
        invalidateLayout()
    }

    private func estimatedHeight(for id: String) -> CGFloat {
        if let height = heights[id] { return height }
        if let estimate = anchorHeightEstimate, estimate.id == id { return estimate.height }
        return 100
    }

    override func prepare() {
        super.prepare()
        guard let start = dirtyFromIndex else { return }
        dirtyFromIndex = nil
        var y: CGFloat = start == 0 ? 0 : frames[start - 1].maxY
        let contentWidth = HapiReadingLayout.contentWidth(in: width)
        for index in start..<ids.count {
            y += spacingBefore[index]
            let height = estimatedHeight(for: ids[index])
            let frame = CGRect(x: (width - contentWidth) / 2, y: y, width: contentWidth, height: height)
            if frame != frames[index] {
                frames[index] = frame
                // Never mutate attributes already handed to UIKit. Recreate
                // them lazily only if this row is actually requested again.
                attributes[index] = nil
            }
            y += height
        }
        contentHeight = y + 12
    }

    override var collectionViewContentSize: CGSize { CGSize(width: width, height: contentHeight) }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard !rect.isNull, !frames.isEmpty else { return [] }
        // Positive, non-overlapping rows: binary-search the first possible
        // intersection, then inspect only the viewport/prefetch range.
        var lower = 0
        var upper = frames.count
        while lower < upper {
            let middle = (lower + upper) / 2
            #if DEBUG
            visibleQueryProbeCount += 1
            #endif
            if frames[middle].maxY < rect.minY { lower = middle + 1 }
            else { upper = middle }
        }
        var result: [UICollectionViewLayoutAttributes] = []
        var index = lower
        while index < frames.count {
            #if DEBUG
            visibleQueryProbeCount += 1
            #endif
            let frame = frames[index]
            if frame.minY > rect.maxY { break }
            if frame.intersects(rect) { result.append(attributesForItem(at: index)) }
            index += 1
        }
        return result
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard indexPath.section == 0, frames.indices.contains(indexPath.item) else { return nil }
        return attributesForItem(at: indexPath.item)
    }

    private func attributesForItem(at index: Int) -> UICollectionViewLayoutAttributes {
        if let cached = attributes[index] { return cached }
        let value = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        value.frame = frames[index]
        attributes[index] = value
        #if DEBUG
        attributeCreationCount += 1
        #endif
        return value
    }

    override func shouldInvalidateLayout(forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
                                         withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes) -> Bool {
        abs(preferredAttributes.size.height - originalAttributes.size.height) > 0.5
    }

    override func invalidationContext(forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
                                      withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(forPreferredLayoutAttributes: preferredAttributes,
                                               withOriginalAttributes: originalAttributes)
        let index = originalAttributes.indexPath.item
        guard ids.indices.contains(index), let view = collectionView else { return context }
        let height = max(1, preferredAttributes.size.height)
        let delta = height - estimatedHeight(for: ids[index])
        heights[ids[index]] = height
        if anchorHeightEstimate?.id == ids[index] { anchorHeightEstimate = nil }
        dirtyFromIndex = min(dirtyFromIndex ?? index, index)
        context.invalidateItems(at: [preferredAttributes.indexPath])
        let viewportTop = view.contentOffset.y + view.adjustedContentInset.top
        if followsTail || originalAttributes.frame.maxY <= viewportTop {
            context.contentOffsetAdjustment.y += delta
        } else if originalAttributes.frame.minY <= viewportTop,
                  originalAttributes.frame.minY + height <= viewportTop {
            // A font reduction can make the first partial row shorter than
            // the reading offset. Keep its last point visible, not a later row.
            context.contentOffsetAdjustment.y += originalAttributes.frame.minY + height - 1 - viewportTop
        }
        return context
    }

    override func targetContentOffset(forProposedContentOffset proposedContentOffset: CGPoint) -> CGPoint {
        guard let view = collectionView else { return proposedContentOffset }
        prepare()
        if followsTail { return CGPoint(x: proposedContentOffset.x, y: bottomOffset(view)) }
        if let anchor = anchorForUpdate, let index = indicesByID[anchor.id],
           let frame = layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame {
            // Only clamp against a measured height, never the temporary estimate.
            let offset = heights[anchor.id] == nil ? anchor.offset : max(anchor.offset, 1 - frame.height)
            return CGPoint(x: proposedContentOffset.x,
                           y: frame.minY - offset - view.adjustedContentInset.top)
        }
        return proposedContentOffset
    }

    func bottomOffset(_ view: UICollectionView) -> CGFloat {
        max(-view.adjustedContentInset.top,
            collectionViewContentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
    }

    func correctOffset(to y: CGFloat) {
        guard let view = collectionView, abs(view.contentOffset.y - y) > 0.5 else { return }
        let context = UICollectionViewLayoutInvalidationContext()
        context.contentOffsetAdjustment.y = y - view.contentOffset.y
        invalidateLayout(with: context)
    }
}

private final class TranscriptCollectionView: UICollectionView {
    var accessibilityIntent: (() -> Void)?
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        accessibilityIntent?()
        return super.accessibilityScroll(direction)
    }
}

/// Keep hosting roots alive across unrelated transcript updates. The small
/// SwiftUI wrapper reads the latest builder and inherited environment,
/// including action captures. SwiftUI can diff the resulting row instead of UIKit
/// reinstalling every visible hosting configuration and measuring it again.
@MainActor @Observable
private final class TranscriptContent<Item> {
    var render: (Item) -> AnyView = { _ in AnyView(EmptyView()) }
    var environment = EnvironmentValues()
}

private struct TranscriptHostedRow<Item>: View {
    let item: Item
    let content: TranscriptContent<Item>

    var body: some View {
        content.render(item).environment(\.self, content.environment)
    }
}

public final class TranscriptCollectionController<Item: Identifiable & Equatable>: UIViewController, UICollectionViewDelegate where Item.ID == String {
    private let layout = TranscriptLayout()
    private lazy var collection = TranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
    private var source: UICollectionViewDiffableDataSource<Int, String>!
    private var configuration: AnchoredTranscriptList<Item>?
    private var pending: AnchoredTranscriptList<Item>?
    private var items: [Item] = []
    private var values: [String: Item] = [:]
    private var applying = false
    private var configuredWidth: CGFloat = 0
    private var configuredSpacing: [CGFloat] = []
    private var renderedHistoryVersion = -1
    private var lastJumpToken = 0
    private var reportScheduled = false
    private var lastViewport: TranscriptViewport?
    private let content = TranscriptContent<Item>()
    #if DEBUG
    private(set) var cellConfigurationCount = 0
    #endif
    private let logger = Logger(subsystem: "run.hapi", category: "Transcript")

    public override func loadView() { view = collection }

    public override func viewDidLoad() {
        super.viewDidLoad()
        collection.backgroundColor = .clear
        collection.keyboardDismissMode = .interactive
        collection.contentInsetAdjustmentBehavior = .never
        collection.alwaysBounceVertical = true
        collection.delegate = self
        collection.accessibilityIdentifier = "chat-transcript"
        collection.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "message")
        collection.accessibilityIntent = { [weak self] in
            self?.layout.followsTail = false
            self?.reportViewport(deferred: false)
        }
        source = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) { [weak self] view, index, id in
            let cell = view.dequeueReusableCell(withReuseIdentifier: "message", for: index)
            guard let self, let item = self.values[id] else { return cell }
            #if DEBUG
            self.cellConfigurationCount += 1
            #endif
            let width = HapiReadingLayout.contentWidth(in: view.bounds.width)
            cell.contentConfiguration = UIHostingConfiguration {
                TranscriptHostedRow(item: item, content: self.content)
                    .id(id)
                    .frame(width: width, alignment: .leading)
            }.margins(.all, 0)
            cell.backgroundColor = .clear
            cell.accessibilityIdentifier = "chat-row-\(id)"
            return cell
        }
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard collection.bounds.width > 24 else { return }
        if abs(configuredWidth - collection.bounds.width) > 0.5, !applying {
            if pending == nil { pending = configuration }
            drain()
        } else if layout.followsTail, !applying, !collection.isDragging {
            layout.correctOffset(to: layout.bottomOffset(collection))
        }
        reportViewport()
    }

    func update(_ configuration: AnchoredTranscriptList<Item>) {
        loadViewIfNeeded()
        pending = configuration
        // The first SwiftUI update may arrive before UIKit supplies bounds.
        guard collection.bounds.width > 24 else { return }
        drain()
    }

    private func captureAnchor() -> ReadingAnchor? {
        let top = collection.contentOffset.y + collection.adjustedContentInset.top
        let bottom = collection.contentOffset.y + collection.bounds.height - collection.adjustedContentInset.bottom
        for index in collection.indexPathsForVisibleItems.sorted() {
            guard let id = source.itemIdentifier(for: index), id != configuration?.historyControlID,
                  let frame = layout.layoutAttributesForItem(at: index)?.frame,
                  frame.maxY > top, frame.minY < bottom else { continue }
            return ReadingAnchor(id: id, offset: frame.minY - top)
        }
        return nil
    }

    private func drain() {
        guard !applying, var next = pending else { return }
        pending = nil
        // The producer must give distinct logical rows distinct IDs. As a
        // final guard against repeated deliveries, retain the latest value
        // at the first occurrence's position. Normalize ALL consumers, not
        // only the dictionary: diffable snapshots also reject duplicate IDs.
        var order: [String] = []
        var nextValues: [String: Item] = [:]
        for item in next.items {
            if nextValues[item.id] == nil { order.append(item.id) }
            nextValues[item.id] = item
        }
        let duplicates = next.items.count - order.count
        if duplicates > 0 {
            logger.error("Coalesced \(duplicates) duplicate transcript row IDs")
            next.items = order.compactMap { nextValues[$0] }
        }
        let oldIDs = Set(items.map(\.id))
        let oldHeight = layout.collectionViewContentSize.height
        let widthChanged = abs(configuredWidth - collection.bounds.width) > 0.5
        let contentWidthChanged = abs(HapiReadingLayout.contentWidth(in: configuredWidth)
            - HapiReadingLayout.contentWidth(in: collection.bounds.width)) > 0.5
        let metricsChanged = configuration.map {
            $0.environment.dynamicTypeSize != next.environment.dynamicTypeSize
                || $0.environment.legibilityWeight != next.environment.legibilityWeight
                || $0.environment.hapiTypography != next.environment.hapiTypography
                || $0.environment.locale != next.environment.locale
                || $0.environment.layoutDirection != next.environment.layoutDirection
        } ?? true
        let spacing = next.items.enumerated().map { index, item in
            max(0, next.spacingBefore(index > 0 ? next.items[index - 1] : nil, item))
        }
        let spacingChanged = configuredSpacing != spacing
        let changed = next.items.filter { contentWidthChanged || metricsChanged || values[$0.id] != $0 }.map(\.id)
        let structureChanged = items.map(\.id) != next.items.map(\.id)
        let jump = next.jumpToken != lastJumpToken
        lastJumpToken = next.jumpToken
        if jump { layout.followsTail = true }
        // Opening an inspector expresses reading intent, even at the tail.
        // Closing it does not silently opt back into following new messages.
        if next.isInspectionPresented { layout.followsTail = false }
        // Capture at COMMIT, after any reader motion during the request.
        layout.anchorForUpdate = layout.followsTail ? nil : captureAnchor()
        configuration = next
        // Do not compare/whitelist EnvironmentValues: custom services and
        // closure captures must propagate too, even when every Item is equal.
        content.render = next.content
        content.environment = next.environment
        items = next.items
        values = nextValues
        configuredWidth = collection.bounds.width
        configuredSpacing = spacing
        guard structureChanged || widthChanged || metricsChanged || spacingChanged || !changed.isEmpty else {
            if jump { layout.correctOffset(to: layout.bottomOffset(collection)) }
            layout.anchorForUpdate = nil
            acknowledgeLayout(version: next.historyVersion, madeProgress: false)
            reportViewport()
            return
        }
        applying = true
        layout.setItems(items.map(\.id), width: configuredWidth, spacingBefore: spacing,
                        invalidateMeasurements: metricsChanged)
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(items.map(\.id))
        snapshot.reconfigureItems(changed.filter { oldIDs.contains($0) })
        source.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            self.collection.layoutIfNeeded()
            let target = self.layout.targetContentOffset(forProposedContentOffset: self.collection.contentOffset)
            self.layout.correctOffset(to: target.y)
            self.layout.anchorForUpdate = nil
            self.applying = false
            let addedRows = self.items.contains { $0.id != next.historyControlID && !oldIDs.contains($0.id) }
            let grew = self.layout.collectionViewContentSize.height > oldHeight + 1
            self.acknowledgeLayout(version: next.historyVersion, madeProgress: addedRows || grew)
            self.reportViewport()
            self.drain()
        }
    }

    private func acknowledgeLayout(version: Int, madeProgress: Bool) {
        guard version != renderedHistoryVersion else { return }
        renderedHistoryVersion = version
        let callback = configuration?.onLayout
        DispatchQueue.main.async { [weak self] in
            self?.reportViewport(deferred: false)
            callback?(version, madeProgress)
        }
    }

    private func reportViewport(deferred: Bool = true) {
        if deferred {
            guard !reportScheduled else { return }
            reportScheduled = true
            DispatchQueue.main.async { [weak self] in
                self?.reportScheduled = false
                self?.reportViewport(deferred: false)
            }
            return
        }
        guard !applying, collection.bounds.height > 0, configuration != nil else { return }
        let height = collection.bounds.height - collection.adjustedContentInset.top - collection.adjustedContentInset.bottom
        let top = max(0, collection.contentOffset.y + collection.adjustedContentInset.top)
        let bottomDistance = layout.bottomOffset(collection) - collection.contentOffset.y
        let short = layout.collectionViewContentSize.height <= height + 1
        let viewport = TranscriptViewport(
            followsTail: layout.followsTail,
            needsOlder: configuration?.isInspectionPresented != true && (short || (!layout.followsTail && top <= height)),
            isAtBottom: bottomDistance <= 1
        )
        guard viewport != lastViewport else { return }
        lastViewport = viewport
        configuration?.onViewport(viewport)
    }

    public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        layout.followsTail = false
        layout.anchorForUpdate = nil
        reportViewport(deferred: false)
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if configuration?.isInspectionPresented != true, !applying, (collection.isDragging || collection.isDecelerating) {
            layout.followsTail = layout.bottomOffset(collection) - collection.contentOffset.y <= 1
        }
        reportViewport(deferred: !(collection.isDragging || collection.isDecelerating))
    }

    public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { finishGesture() }
    }

    public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { finishGesture() }

    private func finishGesture() {
        layout.followsTail = configuration?.isInspectionPresented != true && layout.bottomOffset(collection) - collection.contentOffset.y <= 1
        reportViewport(deferred: false)
    }
}
#endif
