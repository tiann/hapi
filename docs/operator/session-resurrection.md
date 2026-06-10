# Session resurrection - recovering "dead" HAPI chats

> **Rule:** no HAPI session is ever lost just because the hub thinks it crashed.
> The conversation lives on disk in three independent stores. This doc shows
> how to bring an archived session back to life with full context, in one
> command, and the structural reasons it can die in the first place.

---

## What "dead" actually means

When the HAPI hub marks a session as `lifecycleState: 'archived'` with
`archiveReason: 'Session crashed'`, it is hiding the session from the UI.
It is NOT deleting:

| What                          | Where                                                  | Survives crash? |
|-------------------------------|--------------------------------------------------------|-----------------|
| Hub chat scrollback           | `~/.hapi/hapi.db` `messages` table (rows by `session_id`) | yes - all of it |
| Cursor chat blob store        | `~/.cursor/chats/<md5(workspace-path)>/<chat-uuid>/store.db` | yes - all of it |
| Cursor display transcript     | `~/.cursor/projects/<path-slug>/agent-transcripts/<uuid>.jsonl` | yes - all of it |
| Session metadata + linkage    | `~/.hapi/hapi.db` `sessions.metadata` JSON              | **partially lost** - see below |

The actual failure mode the operator sees is:
- The session disappears from the web UI's main list (it is in `archived`).
- Clicking resume in the UI returns `resume_unavailable`.
- The hub log shows `cursorSessionId` was wiped from metadata at archive time.

The data is fine. The pointer is broken.

---

## One-command recovery

```bash
hapi-resurrect-session <hapi-session-id-or-prefix>
```

The script (in `scripts/tooling/hapi-resurrect-session.sh`, symlinked to
`~/.local/bin/hapi-resurrect-session`) is idempotent and does the full
resurrection:

1. **Discovers** the Cursor chat UUID by hashing `metadata.path` with MD5
   and finding `~/.cursor/chats/<hash>/<uuid>/store.db`. Picks the newest
   non-empty candidate if there are multiple.
2. **Patches** the session's sqlite metadata:
   - `cursorSessionId         = <discovered uuid>`
   - `cursorSessionProtocol   = stream-json` (forces legacy launcher dispatch)
   - `lifecycleState          = inactive` (un-archives)
   - removes `archivedBy` and `archiveReason`
3. Optionally **symlinks** an old workspace path to a moved worktree
   (Cursor chat hashes are stable to path - if you moved the worktree
   post-spawn, the chat store is still under the OLD hash).
4. **Restarts the hub** (self-exempt patient drain) so the in-memory
   metadata cache reloads from sqlite.
5. **POSTs** `/api/sessions/<id>/resume` which spawns
   `cursor-agent --resume <uuid>`. The fork's dispatcher patch
   (`cursorRemoteLauncher.ts`) falls back to the legacy stream-json
   launcher when ACP `session/load` fails on a legacy UUID.
6. **Reports** the NEW session ID assigned by the hub (resume always
   creates a child row and transfers messages from the original).

### Common shapes

Stock recovery (path unchanged):

```bash
hapi-resurrect-session 74216b80 --name 'rafflemoviebot (recovered)'
```

Worktree was moved (chat store still keyed to old path):

```bash
hapi-resurrect-session 5806aa57 \
    --name 'PR798 scratchlist (recovered)' \
    --symlink-old-path /home/heavygee/coding/hapi-scratchlist-per-session \
    --as /home/heavygee/coding/hapi/worktrees/scratchlist-per-session
```

Plan-only (no mutations):

```bash
hapi-resurrect-session 5806aa57 --dry-run
```

You will see the live session's new ID in the final log line:

```
[hapi-resurrect-session] resurrected: original=5806aa57-...  live=5980cb9f-...
[hapi-resurrect-session] DONE. Open in HAPI web UI: session id 5980cb9f-...
```

The new ID inherits all messages and the running cursor-agent process.

---

## Why this happens (the structural defects)

Three independent bugs combined to produce the dead-session symptom:

### 1. Hub wipes `cursorSessionId` on archive

When the runner reports a session crash, the hub flips
`metadata.lifecycleState` to `archived` and sets `archivedBy`/`archiveReason`,
but the prior metadata blob may already be missing `cursorSessionId` if the
crash happened before cursor-agent reported back its session UUID. Result:
the hub has no resume token to hand back to the agent on the next resume
attempt, so it returns `resume_unavailable`.

### 2. Cursor-agent has a workspace-path-keyed chat store

Cursor saves its per-chat blob store at
`~/.cursor/chats/<md5(workspace-path)>/<chat-uuid>/store.db`. If you move
the workspace (rename, reorg, switch to a worktree under a different
parent), the hash changes and Cursor cannot find the store any more even
though the file is still on disk under the OLD hash. The
`--symlink-old-path` flag works around this by making the OLD path
resolve to the new worktree.

### 3. HAPI's CLI dispatcher forces ACP for new sessions, even on legacy resume

`cursorRemoteLauncher.ts` calls `resolveCursorRemoteProtocol(metadata)`,
which defaults to ACP when `cursorSessionProtocol` is unset. A
runner-spawned `hapi cursor --resume <legacy-uuid>` creates a fresh
metadata blob without that field, so the dispatcher picks ACP, ACP's
`session/load` rejects the legacy UUID, and the cursor-agent process
exits with code 143. The fork patches the dispatcher to fall back to
the stream-json launcher when ACP fails for a known legacy reason:

```ts
// driver/cli/src/cursor/cursorRemoteLauncher.ts
try {
    return await cursorAcpRemoteLauncher(session);
} catch (error) {
    if (session.sessionId && LEGACY_FALLBACK_ERROR_PATTERN.test(...)) {
        logger.warn('[cursor] ACP load failed for legacy resume token; falling back to stream-json launcher', error);
        return cursorLegacyRemoteLauncher(session);
    }
    throw error;
}
```

The patch is small, backwards-compatible (the existing test suite still
passes), and only changes behavior when ACP throws the specific legacy
error pattern. Once promoted to its own feature branch (see "Upstream
this" below), the manifest layer will keep it alive across rebuilds.

---

## Manual recovery (if the script does not fit your case)

If you need to recover something exotic, the underlying steps are:

```sql
-- 1. Confirm the session is in fact archived with no resume token.
SELECT id, json_extract(metadata, '$.lifecycleState'), json_extract(metadata, '$.cursorSessionId')
FROM sessions WHERE id LIKE 'SOMEPREFIX%';
```

```bash
# 2. Find the Cursor chat UUID by hashing the workspace path.
echo -n '/home/heavygee/coding/<workspace-path>' | md5sum
ls ~/.cursor/chats/<that-md5>/   # one or more chat UUIDs

# 3. Pick the candidate with the biggest store.db / newest mtime.
ls -la ~/.cursor/chats/<that-md5>/*/store.db
```

```python
# 4. Patch the metadata.
import json, sqlite3, time
con = sqlite3.connect('/home/heavygee/.hapi/hapi.db')
row = con.execute('SELECT metadata, metadata_version FROM sessions WHERE id=?', (sid,)).fetchone()
md = json.loads(row[0]); md['cursorSessionId'] = chat_uuid
md['cursorSessionProtocol'] = 'stream-json'; md['lifecycleState'] = 'inactive'
md.pop('archivedBy', None); md.pop('archiveReason', None)
con.execute('UPDATE sessions SET metadata=?, metadata_version=? WHERE id=?',
            (json.dumps(md), int(row[1] or 0) + 1, sid))
con.commit()
```

```bash
# 5. Restart hub so in-memory metadata cache reloads.
hapi-restart-hub
# 6. Resume.
curl -X POST http://127.0.0.1:3006/api/sessions/<sid>/resume \
     -H "Authorization: Bearer $(... acquire JWT ...)" \
     -H 'Content-Type: application/json' -d '{}'
```

`scripts/tooling/hapi-resurrect-session.sh` is exactly the above wrapped in
discovery + safety checks + post-spawn verification.

---

## Upstream this (TODO)

The current fork-only mitigations should be promoted upstream:

- [ ] Promote the `cursorRemoteLauncher.ts` ACP-to-legacy fallback into a
      proper feature branch (e.g. `fix/cursor-acp-legacy-fallback`) and
      add it to the manifest so rebuilds preserve it.
- [ ] File a hub bug: when the hub archives a crashed cursor session, it
      should preserve `cursorSessionId` in metadata so the next resume
      call can hand the agent a resume token (rather than returning
      `resume_unavailable`).
- [ ] File a web-UI bug: archived sessions should expose a "Resurrect"
      action that calls this same flow, rather than just hiding the
      session under the archived filter with no way to recover.
- [ ] File a CLI bug: the dispatcher should consult the sqlite store
      for any prior session with matching `cursorSessionId` before
      defaulting to ACP - that way a crash-and-respawn keeps the
      protocol stable without a manual metadata patch.

---

## See also

- `scripts/tooling/hapi-resurrect-session.sh` - the script itself
- `scripts/attach-agent-chat.{sh,ts}` - the original "attach legacy chat" tool (works for chats that were never linked to HAPI to begin with)
- `scripts/backfill-agent-transcript.ts` - imports Cursor transcript lines into the HAPI messages table for empty scrollback
- `localdocs/operator/reconnect-session.sh` - older reconnect helper for sessions that have lost only `cursorSessionId` (this script obsoletes it for the crash-archive case)
- `docs/operator/repo-layout-and-dev-flow.md` - fork repo + branching + tooling overview
