import HapiClient
import SwiftUI

/// Reusable SwiftUI presentation for ``RemoteDirectoryBrowserModel``.
struct RemoteDirectoryBrowserView: View {
    @Bindable var model: RemoteDirectoryBrowserModel
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if model.roots.count > 1 {
                    Section("Workspace Roots") {
                        ForEach(model.roots, id: \.self) { root in
                            Button {
                                model.navigate(to: root)
                            } label: {
                                Label(root, systemImage: "externaldrive")
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                }

                Section("Current Directory") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(model.breadcrumbs) { breadcrumb in
                                Button(breadcrumb.label) {
                                    model.navigate(to: breadcrumb.path)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                    Text(model.path)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Toggle(
                        "Show Hidden",
                        isOn: Binding(
                            get: { model.includeHidden },
                            set: { model.setIncludeHidden($0) }
                        )
                    )
                }

                Section("Subdirectories") {
                    if model.isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    } else if let error = model.error {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(error).foregroundStyle(.red)
                            Button("Retry") {
                                model.refresh()
                            }
                        }
                    } else if model.entries.isEmpty {
                        Text("No subdirectories")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(model.entries, id: \.name) { entry in
                            Button {
                                model.navigateEntry(entry.name)
                            } label: {
                                HStack {
                                    Image(systemName: "folder")
                                    Text(entry.name)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Choose Directory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.close()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Select") {
                        let path = model.path
                        onSelect(path)
                        model.close()
                        dismiss()
                    }
                    .disabled(model.isLoading || model.error != nil)
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button {
                        model.navigateUp()
                    } label: {
                        Label("Up", systemImage: "arrow.up")
                    }
                    .disabled(!model.canGoUp || model.isLoading)

                    Spacer()

                    Button {
                        model.refresh()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isLoading)
                }
            }
        }
    }
}
