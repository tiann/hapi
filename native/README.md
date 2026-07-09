# Native boundary

Rust code here owns OS-adjacent local work only:

- runner daemon/service glue
- process supervision, signal handling, and process-tree cleanup
- PTY lifecycle
- scoped filesystem/search/git helpers

Current helper: `native/hapi-local`.

- `hapi-local service ...` manages launchd/systemd runner auto-start.
- `hapi-local process kill-tree --pid <pid> [--force]` terminates local process trees.
- `hapi-local process spawn-detached --command <cmd> [--arg <arg> ...] [--cwd <dir>]` starts detached local processes.
- `hapi-local process spawn-supervised --command <cmd> [--arg <arg> ...] [--cwd <dir>]` starts a child, prints its PID, proxies stderr, and exits with it.
- `hapi-local pty spawn --command <shell> [--arg <arg> ...] [--cwd <dir>] [--cols <n>] [--rows <n>]` owns PTY lifecycle over a tiny stdin/stdout line protocol.
- `hapi-local fs list-dir --root <root> --path <path>` lists scoped directories for RPC browse paths.
- `hapi-local fs tree --root <root> --path <path> --max-depth <n>` builds scoped directory trees.
- `hapi-local fs read-file --root <root> --path <path>` reads scoped files as base64 JSON.
- `hapi-local fs write-file --root <root> --path <path> --content <base64> [--expected-hash <sha256>]` writes scoped files with optimistic hash checks.

Keep product protocol, Hub/Web behavior, and agent transcript parsing in TypeScript.
The Rust interface should stay small: CLI args/stdout JSON or a narrow local IPC API.

Packaging: compiled `hapi` releases ship `hapi-local` next to the `hapi` binary; `HAPI_NATIVE_HELPER=0` disables it for fallback tests.
