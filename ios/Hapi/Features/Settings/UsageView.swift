import Charts
import HapiClient
import HapiProtocol
import SwiftUI

/// Usage-dashboard state: one in-flight load per range selection (a range
/// switch cancels the previous fetch), device zone for both the `timeZone`
/// param and the calendar fill so the two agree on day keys. Android
/// reference: `feature/settings/UsageViewModel.kt`.
@MainActor @Observable
final class UsageModel {
    enum State {
        case loading
        /// `isForbidden` (403): the hub rejected a non-owner namespace —
        /// explain, don't retry.
        case error(message: String?, isForbidden: Bool)
        /// `bars`: calendar-filled for 7d/30d, sparse for all.
        case data(summary: UsageSummaryResponse, bars: [UsageMath.DailyBar])
    }

    private(set) var range: UsageRange = .sevenDays
    private(set) var state: State = .loading

    private let api: APIClient
    private var loadTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    func start() {
        guard loadTask == nil else { return }
        load()
    }

    func setRange(_ newRange: UsageRange) {
        guard newRange != range else { return }
        range = newRange
        load()
    }

    func retry() {
        load()
    }

    private func load() {
        loadTask?.cancel()
        state = .loading
        let range = self.range
        loadTask = Task {
            do {
                let timeZone = TimeZone.current
                let summary = try await self.api.usageSummary(
                    range: range.rawValue,
                    timeZone: timeZone.identifier
                )
                guard !Task.isCancelled else { return }
                self.state = .data(
                    summary: summary,
                    bars: UsageMath.dailyBars(
                        daily: summary.daily,
                        days: range.days,
                        todayKey: UsageMath.todayKey(timeZone: timeZone)
                    )
                )
            } catch {
                // A cancelled fetch (range switch, dismiss) must not clobber
                // the successor's state.
                guard !Task.isCancelled else { return }
                self.state = .error(
                    message: error.localizedDescription,
                    isForbidden: (error as? APIError)?.status == 403
                )
            }
        }
    }
}

/// Owner-only token-usage dashboard (web `web/src/routes/settings/usage.tsx`
/// twin via the Android port): range segmented control, stat tiles, the
/// Swift Charts daily bar chart with tap/drag day selection, and
/// byAgent/byModel bar lists.
struct UsageView: View {
    @State private var model: UsageModel
    @State private var selectedDay: String?

    init(api: APIClient) {
        _model = State(initialValue: UsageModel(api: api))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                rangePicker

                switch model.state {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                case .error(let message, let isForbidden):
                    DashboardErrorView(isForbidden: isForbidden, message: message) {
                        model.retry()
                    }
                case .data(let summary, let bars):
                    summaryContent(summary: summary, bars: bars)
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.start()
        }
    }

    // MARK: - Range control

    private var rangePicker: some View {
        Picker("Range", selection: rangeBinding) {
            ForEach(UsageRange.allCases, id: \.self) { range in
                Text(range.label).tag(range)
            }
        }
        .pickerStyle(.segmented)
    }

    private var rangeBinding: Binding<UsageRange> {
        Binding(
            get: { model.range },
            set: { newRange in
                selectedDay = nil
                model.setRange(newRange)
            }
        )
    }

    // MARK: - Loaded body

    @ViewBuilder
    private func summaryContent(summary: UsageSummaryResponse, bars: [UsageMath.DailyBar]) -> some View {
        statTiles(summary.totals)

        DashboardCard(title: "Daily tokens") {
            if summary.daily.isEmpty {
                emptyHint
            } else {
                dailyChart(bars: bars)
                if let selectedDay, let bar = bars.first(where: { $0.key == selectedDay }) {
                    selectedDayRow(bar)
                }
            }
        }

        DashboardCard(title: "By agent") {
            UsageBarList(rows: summary.byAgent)
        }
        DashboardCard(title: "By model") {
            UsageBarList(rows: summary.byModel)
        }

        Text("Sessions with usage: \(summary.totals.sessions)")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyHint: some View {
        Text("No usage recorded in this period.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    // MARK: - Stat tiles

    private struct StatTile: Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    private func statTiles(_ totals: UsageSummaryTotals) -> some View {
        let tiles: [StatTile] = [
            StatTile(label: String(localized: "Total tokens"), value: UsageMath.formatTokens(totals.totalTokens)),
            StatTile(label: String(localized: "Uncached"), value: UsageMath.formatTokens(totals.uncachedTokens)),
            StatTile(label: String(localized: "Input"), value: UsageMath.formatTokens(totals.inputTokens)),
            StatTile(label: String(localized: "Output"), value: UsageMath.formatTokens(totals.outputTokens)),
            StatTile(label: String(localized: "Cache read"), value: UsageMath.formatTokens(totals.cacheReadTokens)),
            StatTile(label: String(localized: "Cache creation"), value: UsageMath.formatTokens(totals.cacheCreationTokens)),
            StatTile(label: String(localized: "Cache hit rate"), value: UsageMath.cacheHitRate(totals)),
            StatTile(label: String(localized: "Requests"), value: UsageMath.formatTokens(totals.requests)),
        ]
        return LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)],
            spacing: 8
        ) {
            ForEach(tiles) { tile in
                VStack(alignment: .leading, spacing: 2) {
                    Text(tile.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(tile.value)
                        .font(.title3.weight(.semibold))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Daily chart

    private func dailyChart(bars: [UsageMath.DailyBar]) -> some View {
        Chart(bars) { bar in
            BarMark(
                x: .value("Day", bar.key),
                y: .value("Tokens", bar.totalTokens)
            )
            .foregroundStyle(Color.accentColor)
            .opacity(selectedDay == nil || selectedDay == bar.key ? 1 : 0.45)
            .cornerRadius(3)
        }
        .chartXSelection(value: $selectedDay)
        .chartXAxis {
            AxisMarks(values: xAxisKeys(bars)) { value in
                AxisValueLabel {
                    if let key = value.as(String.self) {
                        Text(UsageMath.shortDayLabel(key))
                            .font(.caption2)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let tokens = value.as(Int.self) {
                        Text(UsageMath.formatTokens(tokens))
                            .font(.caption2)
                    } else if let tokens = value.as(Double.self) {
                        Text(UsageMath.formatTokens(Int(tokens)))
                            .font(.caption2)
                    }
                }
            }
        }
        .frame(height: 180)
    }

    /// First / middle / last day labels (the middle only once there is room),
    /// mirroring the Android chart's sparse axis.
    private func xAxisKeys(_ bars: [UsageMath.DailyBar]) -> [String] {
        guard let first = bars.first, let last = bars.last else { return [] }
        var keys = [first.key]
        if bars.count >= 5 {
            keys.append(bars[bars.count / 2].key)
        }
        if last.key != first.key {
            keys.append(last.key)
        }
        return keys
    }

    private func selectedDayRow(_ bar: UsageMath.DailyBar) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(bar.key)
                .font(.caption.weight(.medium))
            Spacer(minLength: 8)
            Text(selectedDayDetail(bar))
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.top, 4)
    }

    private func selectedDayDetail(_ bar: UsageMath.DailyBar) -> String {
        guard let bucket = bar.bucket else { return String(localized: "0 tokens") }
        return String(
            format: String(localized: "%@ tokens · %lld req · in %@ / out %@"),
            UsageMath.formatTokens(bucket.totalTokens),
            Int64(bucket.requests),
            UsageMath.formatTokens(bucket.inputTokens),
            UsageMath.formatTokens(bucket.outputTokens)
        )
    }
}

// MARK: - Ranked share list

/// Ranked share list (byAgent/byModel): name + tokens + a thin track bar
/// scaled to the top row, sub-line with requests and in/out split. Top 8
/// rows, like the web.
private struct UsageBarList: View {
    let rows: [UsageSummaryBucket]

    private static let maxRows = 8

    var body: some View {
        if rows.isEmpty {
            Text("No usage recorded in this period.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            let maxTokens = max(rows[0].totalTokens, 1)
            VStack(spacing: 12) {
                ForEach(Array(rows.prefix(Self.maxRows)), id: \.key) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(row.key)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer(minLength: 12)
                            Text(UsageMath.formatTokens(row.totalTokens))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        ShareTrack(fraction: Double(row.totalTokens) / Double(maxTokens))
                        Text(String(
                            format: String(localized: "%lld requests · in %@ · out %@"),
                            Int64(row.requests),
                            UsageMath.formatTokens(row.inputTokens),
                            UsageMath.formatTokens(row.outputTokens)
                        ))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// Thin rounded share bar (web 6px track twin); min 2% so tiny rows register.
private struct ShareTrack: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color(.tertiarySystemFill))
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: geo.size.width * min(max(fraction, 0.02), 1))
            }
        }
        .frame(height: 6)
    }
}

extension UsageRange {
    var label: String {
        switch self {
        case .sevenDays: return String(localized: "7 days")
        case .thirtyDays: return String(localized: "30 days")
        case .all: return String(localized: "All time")
        }
    }
}
