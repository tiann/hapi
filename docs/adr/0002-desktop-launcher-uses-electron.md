# Desktop Launcher uses Electron

HAPI Desktop Launcher will use Electron as its cross-platform desktop shell. The launcher primarily needs tray integration, hidden-window behavior, child-process management, and live log piping, which fit Electron's main-process model better than introducing a Rust/Tauri stack for the first desktop version.
