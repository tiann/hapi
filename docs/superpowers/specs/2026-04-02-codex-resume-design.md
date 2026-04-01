# Codex Resume Deterministic Recovery Design

## Summary

Improve HAPI Codex resume so explicit `hapi codex resume <sessionId>` behaves deterministically and only reports success when both transcript recovery and remote thread reattachment succeed.

This design intentionally targets the first high-value fix only:
- deterministic transcript resolution by `sessionId`
- strict remote reattach to the original Codex thread
- no fuzzy adoption when user explicitly requested a session id

Out of scope for this design:
- injecting parsed history into app-server `thread/resume(history)`
- improving UI rendering for compaction/token/context events
- broad refactors of Codex event conversion

## Problem

Current Codex resume mixes two different concerns:

1. finding the correct local transcript file
2. reattaching remote control to the original live thread

Today, explicit resume still flows through scanner logic designed for ambiguous adoption:
- scanner walks `~/.codex/sessions/YYYY/MM/DD`
- matching depends on `cwd`, timestamps, time window, recent activity
- date filtering can exclude older session files entirely

This is too conservative for explicit user intent. A known `sessionId` should not be treated like an unknown session.

Current remote behavior is also too permissive:
- remote launcher attempts `thread/resume(threadId)`
- if it fails, it silently falls back to `thread/start`

That creates false success semantics:
- history may appear
- a new live thread may be created
- user thinks the original session was resumed, but it was not

## Goals

### Functional goals
- Explicit resume resolves the Codex transcript file directly from `sessionId`
- Transcript recovery is deterministic; no fuzzy matching in explicit resume mode
- Remote attach must reconnect to the original thread id
- If remote reattach fails, overall resume fails
- No silent fallback to a new thread during explicit resume

### Success criteria
An explicit Codex resume is only considered successful if all are true:
- exactly one matching transcript file is resolved
- transcript history is replayed into HAPI
- remote `thread/resume` succeeds for the same session/thread id
- subsequent live turns continue on that same thread

### Non-goals
- perfect recovery for sessions with corrupted or missing local transcript files
- redesigning Codex app-server protocol usage
- solving all missing Codex event/UI fidelity issues

## Reference: why Claude is more reliable

Claude has two properties Codex currently lacks:

1. deterministic file path derivation
   - `cwd -> project dir`
   - `sessionId -> exact jsonl path`
2. explicit runtime session continuity updates
   - hook-based session notifications
   - SDK/init path updates HAPI when session id changes

Codex cannot copy this 1:1 today because HAPI does not have an equivalent Codex session-start hook path. But it can adopt the key reliability principle:
- file-first deterministic recovery for explicit resume
- strict remote continuation semantics

## Proposed architecture

Split explicit Codex resume into two independent but coordinated stages.

### Stage A: deterministic transcript attach

For explicit `resumeSessionId`:
- resolve `CODEX_HOME|~/.codex/sessions/**/*-<sessionId>.jsonl`
- require exactly one match
- parse first line `session_meta`
- validate `session_meta.payload.id === resumeSessionId`
- use that file directly for history replay and incremental watch

Behavioral rules:
- do not run fuzzy `cwd + timestamp + recent activity` adoption
- do not use session date prefix narrowing for explicit resume
- do not adopt a different session if lookup fails

### Stage B: strict remote thread attach

For explicit `resumeSessionId` in remote mode:
- call `thread/resume({ threadId: resumeSessionId, ...threadParams })`
- if success, continue normal turn flow
- if failure, explicit resume fails immediately
- do not fall back to `thread/start`

Behavioral rules:
- explicit resume means attach original thread or fail
- new thread creation is allowed only for non-resume sessions

## Components and file responsibilities

### New: deterministic resolver
**File:** `cli/src/codex/utils/resolveCodexSessionFile.ts`

Responsibility:
- find transcript file(s) for a specific Codex session id
- classify result as `found`, `not_found`, or `ambiguous`
- validate `session_meta`
- return structured metadata needed by launcher/scanner

Proposed return shape:
- `status: 'found' | 'not_found' | 'ambiguous' | 'invalid'`
- `sessionId`
- `filePath?`
- `cwd?`
- `timestamp?`
- `matches?`
- `reason?`

Why separate helper:
- avoids embedding lookup policy inside scanner internals
- enables focused unit tests
- reusable by launchers and future diagnostics

### Change: Codex session scanner
**File:** `cli/src/codex/utils/codexSessionScanner.ts`

Responsibility after change:
- support two modes
  1. explicit deterministic mode
  2. existing fallback adoption mode

In explicit deterministic mode:
- scanner receives resolved `filePath` and `sessionId`
- only scans/watches the target file
- skips fuzzy candidate selection, date prefix filtering, recent-activity heuristics
- replays transcript and follows appended events from that file

In fallback adoption mode:
- preserve current behavior for non-resume sessions or unknown-session adoption

### Change: local launcher
**File:** `cli/src/codex/codexLocalLauncher.ts`

Responsibility after change:
- if `resumeSessionId` exists, resolve transcript before building scanner
- pass deterministic resolution into scanner
- emit explicit user-visible failure if deterministic resolution fails

Local launcher still launches `codex resume <sessionId>` for Codex CLI, but HAPI no longer treats scanner fuzzy matching as acceptable recovery for explicit resume.

### Change: remote launcher
**File:** `cli/src/codex/codexRemoteLauncher.ts`

Responsibility after change:
- explicit resume uses strict `thread/resume`
- if `thread/resume` fails, abort explicit resume path
- remove silent `resume -> startThread` fallback for explicit resume
- `thread/start` remains valid only when there is no explicit resume session id

## State model

### Explicit resume state machine
1. receive `resumeSessionId`
2. resolve transcript file
3. if resolve fails -> overall resume failure
4. initialize deterministic scanner on resolved file
5. start transcript replay/watch
6. remote launcher calls `thread/resume(resumeSessionId)`
7. if remote attach fails -> overall resume failure
8. if remote attach succeeds -> live turns proceed normally

### Failure semantics

#### Transcript resolve failure
Examples:
- no matching file
- multiple matching files
- invalid first line
- `session_meta.payload.id` mismatch

Result:
- explicit resume fails
- no fuzzy adoption fallback
- message explains exact cause

#### Transcript ok, remote attach fails
Result:
- overall explicit resume fails
- message should make clear that history may be present but original live thread was not reattached
- no fallback new thread creation

#### Remote attach ok, transcript missing
Result:
- overall explicit resume fails under this design
- success requires both transcript recovery and remote reattach

## User-visible behavior

For explicit resume, user-visible messaging should reflect hard truth, not best-effort ambiguity.

Examples:
- `Resolved Codex transcript for session <id>: <path>`
- `Failed to resolve Codex transcript for session <id>: not found`
- `Failed to reattach Codex remote thread <id>; explicit resume aborted`

Important:
- do not emit messages that imply success before both stages are complete
- do not silently continue on a replacement thread

## Testing strategy

Write necessary tests only.

### 1. Resolver unit tests
**File:** `cli/src/codex/utils/resolveCodexSessionFile.test.ts`

Cover:
- one matching file -> found
- zero matching files -> not_found
- multiple matching files -> ambiguous
- invalid first line / invalid json -> invalid
- `session_meta` missing or wrong id -> invalid

### 2. Scanner tests
**File:** `cli/src/codex/utils/codexSessionScanner.test.ts` (new or existing test coverage extension)

Cover:
- explicit deterministic mode scans only the resolved file
- explicit mode replays history from resolved file
- explicit mode watches increments on same file
- explicit mode does not use fuzzy adoption when resolution fails
- fallback adoption mode remains unchanged for non-resume flows

### 3. Remote launcher tests
Target file:
- `cli/src/codex/codexRemoteLauncher.ts` behavior tests

Cover:
- explicit resume + `resumeThread` success -> no `startThread`
- explicit resume + `resumeThread` failure -> overall failure, no `startThread`
- no explicit resume -> `startThread` path still works

## Risks and mitigations

### Risk: strictness may surface failures that were previously hidden
Mitigation:
- this is intended
- false success is worse than explicit failure for resume semantics

### Risk: old sessions with missing local files cannot be resumed
Mitigation:
- acceptable in this phase
- future work can explore history injection or alternate recovery paths

### Risk: scanner changes break non-resume adoption
Mitigation:
- isolate deterministic mode from existing fallback mode
- add tests to preserve current non-resume behavior

## Later extensions

Not part of this design, but compatible with it:
- parse transcript into app-server `history` for `thread/resume`
- better conversion of compaction/context/token events
- richer diagnostics command for Codex session lookup

## Implementation recommendation

Implement in this order:
1. add deterministic resolver helper and tests
2. thread resolver into local launcher + scanner explicit mode
3. enforce strict remote `thread/resume` semantics
4. add remote behavior tests
5. manually validate with known real session ids

## Manual validation targets

Use known dedicated sessions only. Current examples from notes:
- `019d3c3f-ba61-71f1-9316-c6d73e4c0aa4`
- `019d49c4-18fa-73b2-a9f9-202fa9c1966c`
- `019d4482-4e6b-7b90-be84-f4b400b7b69d`

Validation expectations:
- transcript path resolves directly by id
- HAPI history appears from that transcript
- remote attaches to same thread id
- no new replacement thread is created on resume failure
