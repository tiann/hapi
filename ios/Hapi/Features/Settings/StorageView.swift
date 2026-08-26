import Charts
import HapiClient
import HapiProtocol
import SwiftUI

/// Storage-dashboard state: initial load + explicit refresh (web parity).
/// Android reference: `feature/settings/StorageViewModel.kt`.
@MainActor @Observable
final class StorageModel {
    enum State {
        case loading
        /// `isForbidden` (403): non-owner namespace (mirror of the usage
        /// screen).
        case error(message: String?, isForbidden: Bool)
        case data(usage: SqliteStorageUsageResponse, isRefreshing: Bool)
    }

    private(set) var state: State = .loading

    private let api: APIClient
    private var loadTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    func start() {
        guard loadTask == nil else { return }
        refresh()
    }

    func refresh() {
        if case .data(_, true) = state { return }
        loadTask?.cancel()
        if case .data(let usage, _) = state {
            state = .data(usage: usage, isRefreshing: true)
        } else {
            state = .loading
        }
        loadTask = Task {
            do {
                let usage = try await self.api.sqliteStorageUsage()
                guard !Task.isCancelled else { return }
                self.state = .data(usage: usage, isRefreshing: false)
            } catch {
                guard !Task.isCancelled else { return }
                self.state = .error(
                    message: error.localizedDescription,
                    isForbidden: (error as? APIError)?.status == 403
                )
            }
        }
    }
}

/// Owner-only sqlite storage dashboard (web
/// `web/src/routes/settings/storage.tsx` + `StorageUsagePie` twin via the
/// Android port): a Swift Charts `SectorMark` donut of db/wal/shm with the
/// total in the center, legend rows with byte formatting + percents, the
/// total and path rows, and an explicit refresh.
struct StorageView: View {
    @State private var model: StorageModel

    init(api: APIClient) {
        _model = State(initialValue: StorageModel(api: api))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Disk footprint of the hub's SQLite database (database, write-ahead log, shared memory).")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                switch model.state {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                case .error(let message, let isForbidden):
                    DashboardErrorView(isForbidden: isForbidden, message: message) {
                        model.refresh()
                    }
                case .data(let usage, let isRefreshing):
                    StorageUsageCard(usage: usage)
                    HStack {
                        Spacer()
                        Button(isRefreshing
                            ? String(localized: "Refreshing…")
                            : String(localized: "Refresh")) {
                            model.refresh()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isRefreshing)
                    }
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Storage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.start()
        }
    }
}

/// Donut + legend + total/path rows for one sqlite usage snapshot.
private struct StorageUsageCard: View {
    let usage: SqliteStorageUsageResponse

    var body: some View {
        let slices = StorageMath.slices(usage)
        DashboardCard(title: "SQLite files") {
            if slices.isEmpty {
                Text("No storage data reported.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                donut(slices: slices)
                VStack(spacing: 8) {
                    ForEach(slices, id: \.key) { slice in
                        legendRow(slice)
                    }
                }
            }
            Divider()
            LabeledContent {
                Text(UsageMath.formatBytes(usage.totalBytes))
            } label: {
                Text("Total")
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
            VStack(alignment: .leading, spacing: 2) {
                Text("Path")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(usage.path)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
        }
    }

    /// `SectorMark` derives its shares from the byte values; data order is
    /// the fixed entity order from `StorageMath`, and the default 12-o'clock
    /// start matches the web geometry. The hero total sits in the hole.
    private func donut(slices: [StorageMath.Slice]) -> some View {
        Chart(slices, id: \.key) { slice in
            SectorMark(
                angle: .value("Bytes", slice.bytes),
                innerRadius: .ratio(0.62),
                angularInset: slices.count > 1 ? 1.5 : 0
            )
            .foregroundStyle(sliceColor(slice.key))
            .cornerRadius(2)
        }
        .chartBackground { proxy in
            GeometryReader { geo in
                if let plotFrame = proxy.plotFrame {
                    let frame = geo[plotFrame]
                    VStack(spacing: 2) {
                        Text(UsageMath.formatBytes(usage.totalBytes))
                            .font(.title3.weight(.semibold))
                        Text("Total")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .position(x: frame.midX, y: frame.midY)
                }
            }
        }
        .frame(height: 200)
    }

    private func legendRow(_ slice: StorageMath.Slice) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 3)
                .fill(sliceColor(slice.key))
                .frame(width: 10, height: 10)
            Text(sliceLabel(slice.key))
                .font(.subheadline)
            Spacer(minLength: 12)
            Text("\(UsageMath.formatBytes(slice.bytes)) · \(StorageMath.formatPercent(slice.percent))")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    /// Fixed per entity — a missing wal/shm file never repaints its
    /// neighbors — and the legend rows carry identity, so color is never the
    /// only channel. Accent-anchored so all theme modes track.
    private func sliceColor(_ key: StorageMath.SliceKey) -> Color {
        switch key {
        case .database: return Color.accentColor
        case .wal: return Color.accentColor.opacity(0.55)
        case .shm: return Color.secondary
        }
    }

    private func sliceLabel(_ key: StorageMath.SliceKey) -> String {
        switch key {
        case .database: return String(localized: "Database")
        case .wal: return String(localized: "Write-ahead log")
        case .shm: return String(localized: "Shared memory")
        }
    }
}
