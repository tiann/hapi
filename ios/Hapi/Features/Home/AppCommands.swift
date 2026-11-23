import SwiftUI

/// Actions the focused home window offers to the menu bar (Mac) and the
/// hardware-keyboard shortcut overlay (iPad).
struct HomeCommandActions {
    var newSession: () -> Void
    var openSettings: () -> Void
    /// Nil when the window has no sidebar to toggle (iPhone stack).
    var toggleSidebar: (() -> Void)?
    /// Selects the row above (-1) or below (+1) the open session.
    var selectAdjacentSession: ((Int) -> Void)?
}

/// Actions of the chat shown in the focused window.
struct ChatCommandActions {
    var openSessionSettings: () -> Void
    var openFiles: () -> Void
    var rename: () -> Void
    var export: (() -> Void)?
    /// Nil unless the agent is mid-turn.
    var stop: (() -> Void)?
}

private struct HomeCommandActionsKey: FocusedValueKey {
    typealias Value = HomeCommandActions
}

private struct ChatCommandActionsKey: FocusedValueKey {
    typealias Value = ChatCommandActions
}

extension FocusedValues {
    var homeCommands: HomeCommandActions? {
        get { self[HomeCommandActionsKey.self] }
        set { self[HomeCommandActionsKey.self] = newValue }
    }

    var chatCommands: ChatCommandActions? {
        get { self[ChatCommandActionsKey.self] }
        set { self[ChatCommandActionsKey.self] = newValue }
    }
}

struct HapiCommands: Commands {
    @FocusedValue(\.homeCommands) private var home
    @FocusedValue(\.chatCommands) private var chat
    @Environment(\.openURL) private var openURL

    private static let guideURL = URL(string: "https://hapi.run/docs/guide/native-apps")

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Session") { home?.newSession() }
                .keyboardShortcut("n")
                .disabled(home == nil)
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { home?.openSettings() }
                .keyboardShortcut(",")
                .disabled(home == nil)
        }
        // The composer is plain text; Format › Bold/Italic would also
        // shadow ⌘I.
        CommandGroup(replacing: .textFormatting) {}
        // Not a document app and no customizable toolbar.
        CommandGroup(replacing: .saveItem) {}
        CommandGroup(replacing: .importExport) {}
        CommandGroup(replacing: .toolbar) {
            Button("Toggle Sidebar") { home?.toggleSidebar?() }
                .keyboardShortcut("s", modifiers: [.command, .control])
                .disabled(home?.toggleSidebar == nil)
        }
        CommandGroup(replacing: .help) {
            if let url = Self.guideURL {
                Button("HAPI Guide") { openURL(url) }
            }
        }
        CommandMenu("Session") {
            Button("Session Settings…") { chat?.openSessionSettings() }
                .keyboardShortcut("i")
                .disabled(chat == nil)
            Button("Session Files") { chat?.openFiles() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(chat == nil)
            Divider()
            Button("Rename…") { chat?.rename() }
                .disabled(chat == nil)
            Button("Export Conversation…") { chat?.export?() }
                .disabled(chat?.export == nil)
            Divider()
            Button("Stop") { chat?.stop?() }
                .keyboardShortcut(".")
                .disabled(chat?.stop == nil)
            Divider()
            Button("Previous Session") { home?.selectAdjacentSession?(-1) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                .disabled(home?.selectAdjacentSession == nil)
            Button("Next Session") { home?.selectAdjacentSession?(1) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(home?.selectAdjacentSession == nil)
        }
    }
}
