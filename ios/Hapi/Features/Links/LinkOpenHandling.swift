import HapiUI
import SafariServices
import SwiftUI

/// App-level handler for everything HapiUI markdown emits through
/// `\.hapiOpenURL` (the renderer never opens anything itself and has already
/// dropped `HrefPolicy.blocked` links):
///
/// - `hapi-file://?path=&line=` workspace citations → `openWorkspaceFile`
///   when installed (the chat routes them into the A-M4a session file
///   viewer, full mode, cited line as a hint), else an explanatory alert;
/// - `https` (and, after confirmation, `http`) → in-app
///   `SFSafariViewController`;
/// - other `HrefPolicy.allowed` schemes (`mailto`, …) → the system open;
/// - `HrefPolicy.confirmFirst` schemes → alert first, then open.
///
/// Installed once at the root (see `RootView`) so links behave identically
/// wherever markdown renders; `ChatView` re-installs it over its subtree
/// with the real file opener.
struct LinkOpenHandling: ViewModifier {
    /// Routes workspace-file citations to a real destination; nil shows the
    /// informational alert (the root fallback outside any session).
    var openWorkspaceFile: ((FilePathLink) -> Void)?

    @State private var safariURL: IdentifiedURL?
    @State private var confirmURL: IdentifiedURL?
    @State private var fileNotice: FilePathLink?

    @Environment(\.openURL) private var systemOpenURL

    func body(content: Content) -> some View {
        content
            .environment(\.hapiOpenURL, HapiOpenURLAction { url in
                // Hop to the main actor: link taps arrive from view code,
                // but the action type is a plain @Sendable closure.
                Task { @MainActor in
                    handle(url)
                }
            })
            .sheet(item: $safariURL) { item in
                SafariView(url: item.url)
                    .ignoresSafeArea()
            }
            .alert(
                "Open link?",
                isPresented: Binding(
                    get: { confirmURL != nil },
                    set: { presented in
                        if !presented {
                            confirmURL = nil
                        }
                    }
                ),
                presenting: confirmURL
            ) { item in
                Button("Open") {
                    confirmURL = nil
                    open(item.url)
                }
                Button("Cancel", role: .cancel) {
                    confirmURL = nil
                }
            } message: { item in
                Text(item.url.absoluteString)
            }
            .alert(
                "Workspace file",
                isPresented: Binding(
                    get: { fileNotice != nil },
                    set: { presented in
                        if !presented {
                            fileNotice = nil
                        }
                    }
                ),
                presenting: fileNotice
            ) { _ in
                Button("OK") {
                    fileNotice = nil
                }
            } message: { link in
                Text(String(
                    format: String(localized: "%@\n\nOpen a session chat to browse its files."),
                    link.path + (link.line.map { ":\($0)" } ?? "")
                ))
            }
    }

    @MainActor
    private func handle(_ url: URL) {
        if let fileLink = FilePathLink(url: url) {
            if let openWorkspaceFile {
                openWorkspaceFile(fileLink)
            } else {
                fileNotice = fileLink
            }
            return
        }
        switch HrefPolicy.classify(url) {
        case .allowed:
            open(url)
        case .confirmFirst:
            confirmURL = IdentifiedURL(url: url)
        case .blocked:
            break // defense in depth; the renderer never links these
        }
    }

    @MainActor
    private func open(_ url: URL) {
        let scheme = url.scheme?.lowercased()
        if scheme == "https" || scheme == "http" {
            safariURL = IdentifiedURL(url: url)
        } else {
            systemOpenURL(url)
        }
    }
}

extension View {
    /// Installs the app's `\.hapiOpenURL` handler (plus its presentation
    /// surfaces) for this subtree. Pass `openWorkspaceFile` to route
    /// `hapi-file://` citations into a real viewer instead of the fallback
    /// alert.
    func handlesHapiLinks(openWorkspaceFile: ((FilePathLink) -> Void)? = nil) -> some View {
        modifier(LinkOpenHandling(openWorkspaceFile: openWorkspaceFile))
    }
}

private struct IdentifiedURL: Identifiable {
    let id = UUID()
    let url: URL
}

/// Thin `SFSafariViewController` wrapper — reader-friendly in-app browsing
/// without leaving the session.
private struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
