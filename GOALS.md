# HAPI delivery roadmap

## M1 — Hub-level peer-tools exposure toggle

- Add owner-only `peerToolsEnabled` Hub setting; default on for old settings and responses.
- Apply it to new/resumed bootstrap, Claude HTTP MCP, Codex/OpenCode stdio, and ACP tool advertisements/approvals.
- Remove peer citation/list-discovery steering when off; human session citation text remains usable.
- Done invariant: only confirmed enabled emits steering; unknown state is path-only.
- Entry evidence: real flavor MCP tool-list tests plus prompt-construction tests covering Claude, Codex, OpenCode, and ACP runner paths.

## M2 — Session authorization

- Not activated. Depends on trusted principal/credential custody; see upstream hard-gate audit #1535. Same UID plus a readable owner token cannot be solved by M1.
