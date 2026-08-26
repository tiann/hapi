import HapiClient
import HapiProtocol
import SwiftUI

/// Session config sheet (A-M3b): permission mode / model / effort sections,
/// catalog-driven per flavor — the SwiftUI twin of the Android
/// `SessionConfigSheet`. Pickers apply optimistically through the interactor
/// (`setPermissionMode` & co., server truth reloaded on error); a flavor
/// without a known model catalog simply hides that section.
struct SessionConfigView: View {
    let interactor: ChatInteractor

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let config = interactor.config
        NavigationStack {
            List {
                if !config.active {
                    notice("Session is offline — changes apply after it resumes or may be rejected.")
                } else if config.controlledByUser {
                    notice("Session is controlled from the terminal — config changes will be rejected.")
                }

                if !config.permissionModes.isEmpty {
                    Section("Permission mode") {
                        ForEach(config.permissionModes, id: \.mode) { option in
                            OptionRow(
                                label: option.label,
                                selected: option.mode == (config.permissionMode ?? .default),
                                tone: option.tone
                            ) {
                                interactor.setPermissionMode(option.mode)
                            }
                        }
                    }
                }

                if config.modelOptions != nil || config.modelOptionsLoading {
                    Section("Model") {
                        modelSection(config)
                    }
                }

                if let effortOptions = config.effortOptions {
                    Section("Effort") {
                        let current = normalizedCurrentEffort(config)
                        ForEach(effortOptions, id: \.self) { option in
                            OptionRow(label: option.label, selected: option.value == current) {
                                interactor.setEffort(option.value)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Session Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            interactor.loadModelOptions()
        }
    }

    @ViewBuilder
    private func modelSection(_ config: SessionConfigState) -> some View {
        if config.modelOptionsLoading {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading models…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else if config.modelOptions?.isEmpty != false {
            Text("Model list unavailable for this session.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            let current = normalizedCurrentModel(config)
            ForEach(config.modelOptions ?? [], id: \.self) { option in
                OptionRow(label: option.label, selected: option.value == current) {
                    interactor.setModel(option.value)
                }
            }
        }
    }

    /// Claude models normalize `auto`/`default` to the nil Default row.
    private func normalizedCurrentModel(_ config: SessionConfigState) -> String? {
        config.flavor == "claude" ? ModelCatalog.normalizeClaudeModel(config.model) : config.model
    }

    private func normalizedCurrentEffort(_ config: SessionConfigState) -> String? {
        config.flavor == "claude" ? ModelCatalog.normalizeClaudeEffort(config.effort) : config.effort
    }

    private func notice(_ text: LocalizedStringKey) -> some View {
        Section {
            Label(text, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// One catalog row: label + trailing checkmark, tinted by the mode's tone.
private struct OptionRow: View {
    let label: String
    let selected: Bool
    var tone: PermissionModeTone = .neutral
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack {
                Text(label)
                    .foregroundStyle(toneColor)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var toneColor: Color {
        switch tone {
        case .danger: .red
        case .warning: .orange
        case .neutral, .info: .primary
        }
    }
}
