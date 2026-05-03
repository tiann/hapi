# Codex Fork Support Design Document

## 1. Overview
- Business requirement: HAPI needs first-class Codex fork support instead of only supporting resume.
- Success criteria:
  - CLI supports `hapi codex fork <sessionId>`
  - Hub exposes a fork API and spawns a new HAPI session instead of merging into the old one
  - Web can trigger fork for Codex sessions and navigate to the new forked session
  - Codex remote launcher uses app-server `thread/fork`
- Scope:
  - `cli/` Codex launch + runner spawn arguments
  - `hub/` session fork orchestration + HTTP route
  - `web/` fork action + API client

## 2. Module Interaction Flow
1. User selects fork in CLI or Web.
2. HAPI passes source Codex thread ID as `forkSessionId`.
3. CLI local mode runs `codex fork <threadId>`.
4. CLI remote mode calls Codex app-server `thread/fork`.
5. Codex returns a new thread ID; HAPI stores it as the new session metadata `codexSessionId`.
6. Hub returns the new HAPI session id to the Web client.

## 3. Module Design Details

### CLI

#### 0. Metadata
- Reuse existing `metadata.codexSessionId`
- No new persisted schema field required for parent thread tracking in this change set

#### 1. Interfaces
- Add CLI parse path: `hapi codex fork <sessionId>`
- Add app-server client method: `forkThread`
- Add thread fork param builder: `buildThreadForkParams`

#### 2. Local / Remote Launch
- Local mode:
  - invoke native `codex fork <threadId>`
  - avoid pre-binding old thread id as current session id
  - session scanner discovers the newly created Codex thread
- Remote mode:
  - if `forkSessionId` exists, call `thread/fork`
  - otherwise keep existing resume/start behavior

### Hub

#### 1. Interfaces
- Add `SyncEngine.forkSession(sessionId, namespace)`
- Add HTTP route: `POST /api/sessions/:id/fork`
- Extend machine spawn RPC payload with `forkSessionId`

#### 2. Session Semantics
- Fork differs from resume:
  - resume reactivates or merges into prior conversation identity
  - fork always creates a new HAPI session
- Only Codex sessions are eligible

### Web

#### 1. Interfaces
- Add `api.forkSession(sessionId)`
- Add `useSessionActions().forkSession`
- Add session action menu item `Fork`

#### 2. UX
- User clicks Fork on a Codex session
- Web calls `/fork`
- On success navigate to the new session detail page
- On failure show toast

## 4. Notes
- Parent/child fork lineage is intentionally out of scope
- Automatic inactive-message send still uses resume; fork remains an explicit action
