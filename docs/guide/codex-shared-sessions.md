# Codex shared sessions

Codex **0.154.0 or newer**: the official terminal UI and HAPI Web / native
clients share one app-server. No local/remote ownership switch. Both can send
messages, approve tools and answer `request_user_input`.

```bash
hapi codex                          # launch an execution owned by this terminal
hapi resume <hapi-session-id>        # attach to a live execution on this machine
hapi codex resume <native-thread-id> # cold resume; rejects another live owner
hapi codex resume --last             # latest native thread in the current directory
```

The execution uses the launch's environment, authentication and `CODEX_HOME`.
Independent launches get independent app-servers, not a global agent
service. Reattaching uses the **same executable** as the running app-server, even if PATH
has since changed. A compatible runner is required when one is already running.
Update CLI, Runner and Hub together: the Hub must preserve shared pending input
on execution exit rather than applying the legacy session-end queue sweep.

## Lifecycle

- **Terminal-created execution**: the original terminal owns its lifetime.
  `/exit` or closing that terminal stops its app-server. All roots in that
  execution become **inactive, not archived**; attached terminals disconnect.
- **Web-created/resumed execution**: the existing Runner spawns the ordinary
  HAPI wrapper. No primary terminal is required.
- **Additional terminals**: `hapi resume <id>` attaches to the existing engine.
  Exiting an attached terminal only detaches; it never takes lifetime ownership.
- **Web after an execution stops**: the existing resume-on-send flow asks an
  online Runner to restore the same HAPI session/native thread, then delivers
  the message. The Runner must have access to the same native store (`CODEX_HOME`)
  and credentials. No new background Codex daemon or handoff path, and no attempt
  to serialize/recreate an arbitrary terminal environment.
- **Stop**: interrupt the current turn; retain the thread and native queue.
- **End session**: archive that root and its descendants. Sibling roots keep working.
- `/new`, `/clear`: create a new root/HAPI session. Other clients remain on the old root.
- Native `/resume` and `/fork`: bind the selected/new root before exposing the
  lifecycle reply. One HAPI identity is never retargeted to a different thread.
- Web/mobile `/new` and `/clear`: only the initiating view follows the returned
  session ID. No global superseded-session redirect.
- Navigating to a thread owned by another live execution is rejected with a
  `hapi resume <id>` instruction. No duplicate live engine or automatic roaming.

The last archived root shuts down its app-server. Otherwise, lifetime follows
its original terminal or Runner-spawned wrapper, **not frontend count**.
`/new` and fork do not transfer ownership: when the original terminal exits,
its sibling roots also become inactive. Each can later resume independently.
Other executions are unaffected. Interrupted/in-flight work is not blindly
replayed; resume restores durable history, not the old process's memory.

## Messages and questions

Completed Plan-mode proposals remain visible in chat, including after terminal
actions, refresh and resume. The current proposal offers **Implement plan** and
**Continue planning** in Web. Implement switches the native thread to Default
and queues `Implement the plan.`; Continue focuses the composer in Plan mode.
These are client actions, not tool approvals. Codex's terminal-only "stay in Plan
mode" selection does not broadcast a decision to other clients. A new native
turn or mode change withdraws outdated Web controls while retaining the plan.
Codex 0.154 can leave its local confirmation menu open after Web execution;
press **Esc** before entering another terminal command.

Ordinary HAPI messages enter **Codex's native queue**. There is no competing
HAPI queue drainer. Settings are read when a submission executes, not frozen
when it is enqueued. Explicit **Steer** targets the currently observed turn;
a stale turn ID is rejected, not redirected to the next turn.

Native pending queue text is mirrored to HAPI. Native edits and acknowledged
removals update it. Losing a queue entry during transport recovery is not proof
that it was canceled or executed.

Codex arbitrates terminal/Web answers. A submitted Web answer is only a
candidate. Native `serverRequest/resolved` closes the prompt with neutral
**Resolved in Codex** status; HAPI does not invent the winner or their answer.
Disconnect withdraws the old controls; reconnect replays native pending requests.
Canceling a question interrupts its native turn instead of sending an empty
fabricated answer. Unknown side-client request types remain terminal-only.

Each root has its own HAPI socket, MCP bridge and shell `HAPI_SESSION_ID`.
Child-agent traces/permissions are attributed by native ancestry, not merely by
being received on the same app-server connection.

## Recovery and local data

- Hub outage: existing native threads continue. Reconnect reconciles history,
  queue and pending state with stable IDs.
- Runner restart: use existing Runner process tracking/recovery. Live attachment
  uses private endpoint records directly; no extra scan/adoption loop. Unknown
  shared-root webhooks are not grounds to kill a sibling execution.
- Ordinary execution exit: stop new submissions, remove native queued input
  where Codex confirms it has not executed, and retain it for normal Hub replay
  on resume (including native edits and pending upload files). Withdraw pending
  permission/question controls. Stop the engine before publishing inactivity.
- Wrapper/app-server crash: no automatic replay of accepted or uncertain writes.
  A durable per-session queue ledger records unknown outcomes before dispatch.
- Cold resume checks wrapper **and** app-server process generations. A live
  orphan or an unverifiable generation blocks recovery. Inspect and explicitly
  stop that orphan before resuming; never just delete its ownership record.
- Unconfirmed lifecycle operations are quarantined and logged; blindly repeating
  `/new`, fork, or send can otherwise create duplicate work.
- Active legacy local/remote sessions are not hot-migrated. Stop them explicitly
  before cold-resuming with the new CLI.

Private files: `$HAPI_HOME/codex-runtimes` (live endpoint/ownership records, queue
ledgers), `$CODEX_HOME/hapi-runtime-owners` (store-wide ownership, including
across different HAPI homes). Unix sockets live in a short private temporary
directory. Windows uses bearer-authenticated loopback WebSockets. App-server
endpoints/tokens never go into HAPI session metadata or SSE.

## Current boundaries

- Cold resume accepts root threads only. To revisit a child agent, resume its
  parent HAPI session; HAPI does not independently start a child execution.
- HAPI's legacy `safe-yolo` auto-approval policy is not a native Codex mode;
  shared sessions reject it instead of silently weakening or misreporting it.
  Use `default`, `read-only`, `yolo`, or native `--approve-for-me`.
- Web-created new/fork roots preserve the standard native sandbox restrictions.
  Named permission profiles and external sandboxes must be created in the
  native TUI; HAPI never converts them silently to workspace-write.
- `--profile` / `-p`: rejected. Standalone app-server 0.154 cannot select the
  native profile-v2 loader; flattening it into `-c` changes configuration
  precedence. Use a dedicated `CODEX_HOME` or explicit `-c` overrides.
- Web Rewind is available for paginated histories when the installed Codex
  supports `thread/revert`. Select the first user message of a completed turn;
  the selected turn and everything after it are removed from the conversation.
  Files, Git commits, the index and the working tree remain unchanged.
  Rewind requires an idle session, no active goal, no queued or uncertain input, and no
  child-agent history. Legacy histories and cuts inside a steered turn remain
  unsupported; use **Fork at message** instead.
  All terminal and Web writes are blocked until native history is verified and
  the Hub durably truncates its transcript. An uncertain mutation or interrupted
  commit stays blocked across process restarts and requires reconciliation;
  HAPI does not automatically retry it. Native terminal rewind/rollback stays
  disabled: initiate the coordinated operation from Web.
- `--worktree` and unsupported launch flags fail explicitly; create/select the
  working directory before launch. `--oss` requires an explicit
  `--local-provider`. Bare resume pickers use `hapi resume` or the attached TUI.
- Unknown MCP elicitation forms are not answered by HAPI. A side-client error
  response could consume the native callback and dismiss a valid TUI prompt.
- Native image-only prompts retain image placeholders in HAPI; they do not
  upload the terminal's local image as a Web attachment preview.
- macOS real-binary/full-stack tests use isolated homes and a local mock
  Responses endpoint; no Claude subscription or paid model calls required.
  Windows transport authentication is unit-tested; native Windows execution
  still needs platform validation.

## Tests

```bash
bun typecheck
bun run test
HAPI_RUN_SHARED_CODEX_TESTS=1 bun run --cwd cli test -- \
  src/codex/shared/runtime.integration.test.ts \
  src/codex/shared/frontend.integration.test.ts
```

With Node 26's global Web Storage enabled, the existing Web test setup can
conflict with jsdom's `StorageEvent` type. Run the suite with
`NODE_OPTIONS=--no-experimental-webstorage bun run test` in that environment.

The opt-in tests require the installed official Codex binary. The full-stack
terminal test also uses Python 3's standard-library PTY support (POSIX only).
It exercises the actual HAPI CLI/Runner, hub REST/Socket.IO, MCP, app-server and native TUI,
not a fake Codex executable. Coverage includes keyboard/Web answers, sibling
question isolation, native queue editing/deletion, fork, primary-terminal exit,
secondary attachment/detachment, Web→Runner resume with the same HAPI/native
identity, and safe pending-message recovery.

The opt-in `web/e2e/codex-rewind-session.spec.ts` additionally exercises Web
Rewind at desktop and mobile widths against a real Hub, Runner and Codex.
Use a separate `HAPI_HOME`, `CODEX_HOME`, test database and project directory.
Run `scripts/dev/codex-rewind-model-fixture.ts` with an explicit
`HAPI_REWIND_MODEL_PORT`, then configure that isolated Codex home's Responses
provider to use `http://127.0.0.1:<port>/v1` without authentication or WebSockets.
Set `HAPI_REWIND_PROJECT_ROOT` to the disposable project directory, `HAPI_URL`
to the test Hub and `HAPI_ACCESS_TOKEN` to its token before running the Live
Playwright suite with `HAPI_LIVE=1`. The fixture makes Codex execute a shell
tool that modifies and creates files. Assertions verify transcript truncation,
the subsequent model request, file bytes, Git HEAD, index and working tree.
