import HapiClient
import HapiProtocol
import SwiftUI

struct UsageQuotasSection: View {
    let api: APIClient

    @State private var response: UsageQuotasResponse?
    @State private var error: String?
    @State private var canRefresh = true
    @State private var isLoading = false

    var body: some View {
        DashboardCard {
            HStack {
                Text("CLI account quotas")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if isLoading {
                    ProgressView()
                        .accessibilityLabel("Loading quotas")
                } else if canRefresh {
                    Button {
                        Task { await load(refresh: true) }
                    } label: {
                        Label("Refresh quotas", systemImage: "arrow.clockwise")
                            .labelStyle(.iconOnly)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
            }
            if let error {
                Text(error)
                    .foregroundStyle(.secondary)
            }
            if let response {
                let machines = response.machines.filter {
                    !$0.supported || $0.error?.isEmpty == false || !$0.visibleAccounts.isEmpty
                }
                if error != nil && !machines.isEmpty {
                    Text("Last loaded quotas").font(.caption).foregroundStyle(.secondary)
                }
                if machines.isEmpty && error == nil {
                    Text("No online machines reported CLI accounts.")
                        .foregroundStyle(.secondary)
                }
                ForEach(machines, id: \.machineId) { machine in
                    let label = machine.machineName.isEmpty ? machine.machineId : machine.machineName
                    if !machine.supported || (machine.accounts.isEmpty && machine.error?.contains("RPC method not available") == true) {
                        Text("\(label): Update the runner to view quotas.")
                    } else {
                        if response.machines.count > 1 || machine.error?.isEmpty == false {
                            Text(label).font(.caption).foregroundStyle(.secondary)
                        }
                        if let error = machine.error, !error.isEmpty {
                            Text(error)
                        }
                        ForEach(machine.visibleAccounts, id: \.agent) { account in
                            accountRow(account)
                        }
                    }
                }
            }
        }
        .font(.subheadline)
        .task { await load(refresh: false) }
    }

    private func accountRow(_ account: UsageQuotasResponse.Account) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(account.agent.isKnown ? account.agent.displayLabel : account.agent.rawValue)
                .font(.subheadline.weight(.medium))
            let detail = [account.accountLabel, account.planLabel, account.creditsLabel]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(account.buckets, id: \.id) { bucket in
                VStack(alignment: .leading, spacing: 4) {
                    Text(bucket.label)
                    Text("\(Int(bucket.remainingPercent.rounded()))% remaining · \(Int(bucket.usedPercent.rounded()))% used")
                        .font(.caption)
                    ProgressView(value: min(100, max(0, bucket.remainingPercent)), total: 100)
                        .accessibilityHidden(true)
                    if let reset = bucket.resetDate {
                        Text("Resets \(reset.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if let note = statusNote(account) {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func statusNote(_ account: UsageQuotasResponse.Account) -> String? {
        if let note = account.note, !note.isEmpty { return note }
        switch account.status {
        case "unauthenticated": return String(localized: "Not signed in")
        case "custom_provider": return String(localized: "Custom endpoint / API key")
        case "ok" where !account.buckets.isEmpty || account.creditsLabel?.isEmpty == false: return nil
        default: return String(localized: "Quota unavailable")
        }
    }

    @MainActor
    private func load(refresh: Bool) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        error = nil
        do {
            let fresh = try await api.usageQuotas(refresh: refresh)
            try Task.checkCancellation()
            response = fresh
            canRefresh = true
        } catch {
            guard !Task.isCancelled else { return }
            let status = (error as? APIError)?.status
            let authError = error as? AuthError
            if status == 401 || authError == .notPaired || authError == .reauthenticationRequired {
                response = nil
                canRefresh = false
                self.error = String(localized: "Not signed in")
                return
            }
            switch status {
            case 403:
                response = nil
                canRefresh = false
                self.error = String(localized: "Only the hub owner can view CLI account quotas.")
            case 404:
                response = nil
                canRefresh = true
                self.error = String(localized: "Update the hub to view CLI account quotas.")
            default:
                self.error = error.localizedDescription
            }
        }
    }
}
