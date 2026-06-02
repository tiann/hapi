# Desktop Launcher uses a bundled HAPI CLI

HAPI Desktop Launcher will manage Hub and Runner by launching a bundled platform-specific HAPI CLI binary instead of importing Hub/Runner internals directly. This keeps the desktop app aligned with the existing `hapi hub --relay` and `hapi runner start --workspace-root ...` contracts, while avoiding a first-version rewrite of runner lifecycle semantics.
