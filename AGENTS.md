# AGENTS.md

HAPI is a local-first platform for running coding agents with remote control via web/phone.
CLI wraps agents → hub (Socket.IO) → web/native clients (REST + SSE).

## Task boundaries

- Complete the requested deliverable and relevant verification; do not stop at the first implementation unless the user requested a review checkpoint.
- Fix causes within the task's scope. Report unrelated problems rather than turning them into refactors or additional features.
- Make reasonable, reversible choices and continue. Ask when missing information materially affects correctness, an action needs additional authorization, or progress requires overwriting someone else's changes. Continue unaffected work.
- Preserve existing user/agent changes. Editing or generating files does not imply permission to commit, push, or release.
- Keep communication concise and clear; report results, checks performed, and remaining limitations.

## Find context when needed

Start with the task's files; read only relevant sections of these references, not a fixed sequence of READMEs.

| Task area | Entry points |
|-----------|--------------|
| Product, setup, supported agents | [README.md](README.md), [agent guide](docs/guide/agents.md) |
| Agent wrappers, CLI commands, runner | [cli/README.md](cli/README.md); for bootstrap/handoff changes, [session lifecycle invariants](cli/README.md#session-lifecycle-invariants) |
| Hub APIs, auth, sync, notifications | [hub/README.md](hub/README.md) |
| Web routes, components, data fetching | [web/README.md](web/README.md); for optional feature discovery, [FUE](web/README.md#first-user-experience-fue) |
| Shared wire types and validation | `shared/src/types.ts`, `schemas.ts`, `socket.ts`, `modes.ts` |
| Native API contract, chat conformance | [client contract](docs/api/client-contract/index.md), [iOS](ios/README.md), [Android](android/README.md) |
| Encrypted native push relay | [relay/README.md](relay/README.md) |
| Session-attached jobs (outliving work) | [session jobs guide](docs/guide/session-jobs.md), `cli/src/commands/job.ts` |
| User docs / marketing site | `docs/` (VitePress) / `website/` |

## Repository conventions

- Bun workspaces: `cli`, `shared`, `hub`, `web`, `website`, `docs`, `relay`. Run workspace scripts from the root; package-scoped commands may use `bun run --cwd <package> ...` or that package's directory. iOS and Android use separate toolchains.
- TypeScript strict; keep code typed. Prefer 4-space indentation. `@/*` resolves to a package's `src/*`.
- Shared protocol is `@hapi/protocol`; runtime schemas live in `shared/src/schemas.ts` (Zod).
- No backward compatibility required for formats changed by the task; do not add compatibility layers or change unrelated formats.

## Cross-component invariants

- CLI↔hub uses Socket.IO `/cli` with the CLI access token. Web terminals use `/terminal` with a client JWT; ordinary web/native updates use REST + SSE. Preserve namespace isolation (`CLI_API_TOKEN:<namespace>`).
- Metadata/state updates are versioned; preserve stale-update rejection. Permission controls use per-flavor catalogs in `shared/src/modes.ts`, further constrained by session capabilities.
- `shared/fixtures/**` is generated from the web chat pipeline, the source of truth for native conformance. Never hand-edit fixtures. For changes to fixture inputs or generation (paths in [.github/workflows/fixtures.yml](.github/workflows/fixtures.yml)), run `bun run gen:fixtures` and include any generated changes in the deliverable. CI checks drift and runs native conformance on fixture changes.

## Session-attached jobs (outliving work)

When an agent starts process-shaped work that will keep running after the agent goes idle (`nohup`, batch imports, long scripts, external daemons), attach it so the session list stays truthful while `active: false`. This is **not** thinking progress / todos / in-agent background tools.

Agent contract (idle agents cannot heartbeat — bare set + nohup freezes the bar):

1. **Required for process-shaped work:** Shell `hapi job run <session-id> <key> --label … -- <cmd>` (auto-heartbeat + exit status). Use `"$HAPI_SESSION_ID"` only when it matches the operator chat row (`/sessions/<id>` in the web URL).
2. MCP `session_job` **refuses `action=set`**. Use it only for `update` / `clear` / `list` on a job the supervisor already created.
3. Manual CLI `set` only with a self-heartbeating wrapper (`update` ≥~10m); never MCP set + nohup.
4. Prefer honest `--remaining` or `--done`/`--total`; omit counts if unknown — never invent a percent.
5. Elapsed wall clock is always shown from `startedAt` (not an ETA).

Full guide: [docs/guide/session-jobs.md](docs/guide/session-jobs.md). CLI: `hapi job --help`.

## Verification and completion

Choose checks by the change's impact, not by the number of workflow steps:

| Change | Verification |
|--------|--------------|
| Documentation only | Check edited content, local links, and diff; no code test suite. |
| Package-local code | Relevant tests and the package's typecheck where available; add regression coverage when needed. |
| Shared contracts, dependencies, broad cross-package behavior | `bun typecheck && bun run test`, plus affected integration/conformance checks. |
| Native code | Relevant checks from the iOS/Android README using available toolchains. |

- Root scripts: `bun run test:<package>` for `cli`, `hub`, `web`, `shared`, `relay`; `bun run typecheck:<package>` for `cli`, `hub`, `web`, `relay`. Shared types are checked through consumers. CLI/web tests use Vitest; hub/shared/relay use Bun test. Use file filters for focused runs.
- Within existing permissions, run and retry relevant local checks without asking at each step. Fix failures caused by the task; report unrelated failures. If tools or permissions are unavailable, complete other work and state what remains unverified; do not bootstrap native toolchains or wait on CI unless the task requires it.
- Reuse passing checks when code, dependencies, and environment are unchanged; commit/push/PR transitions alone do not require reruns. Run repository-wide checks when explicitly requested as well.
- Review this task's changes for correctness, security, and regressions. For local work, inspect unstaged/staged diffs (`git diff`, `git diff --cached`) and new files; for a branch/PR review, use the actual target branch's merge-base diff. Local self-review does not require a GitHub event, remote review, or posting comments.
