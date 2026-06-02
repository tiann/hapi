# Desktop Launcher provisions a token when none exists

HAPI Desktop Launcher will reuse an existing `CLI_API_TOKEN` when available, preferring `~/.hapi/settings.json` as the stable HAPI service token source, then Electron userData, then the environment. If no token exists, the launcher will generate and store a secure token in Electron userData; this preserves the desired Runner-first startup order while avoiding a first-run Hub bootstrap path or a manual token setup requirement.
