#!/usr/bin/env bash
# hapi-resurrect-session
#
# Bring a hub-archived "dead" HAPI session back to life with full prior
# conversation history attached. Covers the most common archive-on-crash
# failure mode where:
#   - metadata.lifecycleState = 'archived'
#   - metadata.archiveReason  = 'Session crashed'
#   - metadata.cursorSessionId is MISSING (the hub forgot the resume token)
#   - the per-chat store.db is still on disk under ~/.cursor/chats/<hash>/<uuid>/
#   - hub-side scrollback (sqlite messages rows) is intact, just hidden
#
# What this script does (idempotent):
#   1. Discovers the Cursor chat UUID belonging to the HAPI session by
#      matching the metadata.path's MD5 hash to ~/.cursor/chats/<hash>/<uuid>/
#      and picking the candidate with the latest mtime that has a non-empty
#      store.db.
#   2. Patches the session's sqlite metadata to:
#        cursorSessionId          = <discovered uuid>
#        cursorSessionProtocol    = stream-json   (legacy launcher dispatch)
#        lifecycleState           = inactive       (un-archives)
#        removes archivedBy / archiveReason
#   3. Optionally symlinks an old path -> new worktree path when the worktree
#      was moved post-spawn (Cursor chat hashes are stable to path; if the
#      operator moved the worktree, the chat store stays under the OLD hash).
#   4. Restarts the hub via hapi-restart-hub (self-exempt patient drain).
#   5. POSTs /api/sessions/<id>/resume which spawns cursor-agent --resume <uuid>.
#      The dispatcher patch in cursorRemoteLauncher.ts falls back to the
#      stream-json launcher when ACP session/load fails on a legacy UUID.
#   6. Prints the NEW session ID that the hub assigned (resume creates a
#      child row and transfers messages from the original).
#
# Usage:
#   hapi-resurrect-session <hapi-session-id-or-prefix>
#       [--cursor-uuid <uuid>]              # skip auto-discovery
#       [--symlink-old-path <old> --as <new>]  # for moved worktrees
#       [--name '<friendly label>']
#       [--dry-run]
#       [--no-restart-hub]                  # skip the restart step
#
# Examples:
#   hapi-resurrect-session 5806aa57
#   hapi-resurrect-session 74216b80 --name 'rafflemoviebot (recovered)'
#   hapi-resurrect-session 5806aa57 \
#       --symlink-old-path /home/heavygee/coding/hapi-scratchlist-per-session \
#       --as /home/heavygee/coding/hapi/worktrees/scratchlist-per-session
#
# Exit codes:
#   0   session resurrected (or dry-run plan printed)
#   1   discovery failed (no matching cursor chat)
#   2   sqlite patch failed
#   3   hub resume call failed
#   4   spawned cursor-agent crashed within 8s of spawn
#
set -euo pipefail

DB="${HAPI_DB:-$HOME/.hapi/hapi.db}"
HUB="${HAPI_HUB_URL:-http://127.0.0.1:3006}"
SETTINGS="${HAPI_SETTINGS:-$HOME/.hapi/settings.json}"
CHATS_ROOT="${HAPI_CURSOR_CHATS:-$HOME/.cursor/chats}"

SESSION=""
CURSOR_UUID=""
SYMLINK_OLD=""
SYMLINK_NEW=""
NAME=""
DRY=0
NO_RESTART=0

usage() {
    grep -E '^# ' "$0" | sed 's/^# \?//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cursor-uuid)        CURSOR_UUID="$2"; shift 2 ;;
        --symlink-old-path)   SYMLINK_OLD="$2"; shift 2 ;;
        --as)                 SYMLINK_NEW="$2"; shift 2 ;;
        --name)               NAME="$2"; shift 2 ;;
        --dry-run)            DRY=1; shift ;;
        --no-restart-hub)     NO_RESTART=1; shift ;;
        -h|--help)            usage ;;
        -*)                   echo "unknown flag: $1" >&2; usage ;;
        *)                    SESSION="$1"; shift ;;
    esac
done

[[ -z "$SESSION" ]] && usage
[[ -n "$SYMLINK_OLD" && -z "$SYMLINK_NEW" ]] && { echo "--symlink-old-path requires --as <new>"; exit 2; }

if [[ ! -r "$DB" ]]; then
    echo "DB not readable: $DB" >&2
    exit 2
fi
if [[ ! -r "$SETTINGS" ]]; then
    echo "settings not readable: $SETTINGS" >&2
    exit 2
fi

run_py() {
    DB="$DB" HUB="$HUB" SETTINGS="$SETTINGS" CHATS_ROOT="$CHATS_ROOT" \
    SESSION="$SESSION" CURSOR_UUID="$CURSOR_UUID" \
    SYMLINK_OLD="$SYMLINK_OLD" SYMLINK_NEW="$SYMLINK_NEW" \
    NAME="$NAME" DRY="$DRY" NO_RESTART="$NO_RESTART" \
    python3 - <<'PY'
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.request

DB = os.environ['DB']
HUB = os.environ['HUB']
SETTINGS = os.environ['SETTINGS']
CHATS = os.environ['CHATS_ROOT']
SESSION = os.environ['SESSION'].strip()
CURSOR = os.environ.get('CURSOR_UUID', '').strip()
SYM_OLD = os.environ.get('SYMLINK_OLD', '').strip()
SYM_NEW = os.environ.get('SYMLINK_NEW', '').strip()
NAME = os.environ.get('NAME', '').strip()
DRY = os.environ.get('DRY', '0') == '1'
NO_RESTART = os.environ.get('NO_RESTART', '0') == '1'


def die(code, msg):
    sys.stderr.write(f'[hapi-resurrect-session] ERROR: {msg}\n')
    sys.exit(code)


def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def resolve_session(con, prefix):
    rows = con.execute(
        'SELECT id, metadata, metadata_version FROM sessions WHERE id LIKE ?',
        (f'{prefix}%',),
    ).fetchall()
    if not rows:
        die(1, f'no session matches prefix {prefix!r}')
    if len(rows) > 1:
        die(1, f'multiple sessions match {prefix!r}: ' + ', '.join(r[0][:8] for r in rows))
    return rows[0]


def discover_cursor_uuid(metadata_path):
    if not metadata_path:
        die(1, 'session has no metadata.path; cannot auto-discover cursor chat')
    candidates = []
    for path in (metadata_path,) + tuple(
        p for p in (SYM_OLD, SYM_NEW) if p and p != metadata_path
    ):
        h = md5(path)
        d = os.path.join(CHATS, h)
        if not os.path.isdir(d):
            continue
        for entry in os.listdir(d):
            store = os.path.join(d, entry, 'store.db')
            if os.path.isfile(store) and os.path.getsize(store) > 0:
                candidates.append({
                    'uuid': entry,
                    'store': store,
                    'size': os.path.getsize(store),
                    'mtime': os.path.getmtime(store),
                    'workspace_path': path,
                    'workspace_hash': h,
                })
    if not candidates:
        die(1, f'no cursor chat store found under {CHATS}/<md5(path)>/ for any candidate path')
    candidates.sort(key=lambda c: c['mtime'], reverse=True)
    pick = candidates[0]
    others = candidates[1:]
    if others:
        sys.stderr.write(
            f'[hapi-resurrect-session] note: {len(candidates)} candidate(s); using newest:\n'
            f'  {pick["uuid"]}  size={pick["size"]}  mtime={time.ctime(pick["mtime"])}  workspace={pick["workspace_path"]}\n'
        )
        for o in others:
            sys.stderr.write(
                f'  alt: {o["uuid"]}  size={o["size"]}  mtime={time.ctime(o["mtime"])}  workspace={o["workspace_path"]}\n'
            )
    return pick


def hub_token():
    settings = json.load(open(SETTINGS))
    req = urllib.request.Request(
        f'{HUB}/api/auth',
        data=json.dumps({'accessToken': settings['cliApiToken']}).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())['token']


def hub_resume(token, sid):
    req = urllib.request.Request(
        f'{HUB}/api/sessions/{sid}/resume',
        data=b'{}',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        die(3, f'POST /api/sessions/{sid}/resume failed HTTP {e.code}: {body}')


con = sqlite3.connect(DB)
row = resolve_session(con, SESSION)
sid, raw_meta, mver = row[0], row[1], int(row[2] or 1)
md = json.loads(raw_meta or '{}')
metadata_path = md.get('path')

# Decide cursor UUID.
if not CURSOR:
    cand = discover_cursor_uuid(metadata_path)
    CURSOR = cand['uuid']
    discovered_path = cand['workspace_path']
else:
    discovered_path = metadata_path
    sys.stderr.write(f'[hapi-resurrect-session] using explicit --cursor-uuid {CURSOR}\n')

# Symlink old path -> new path if requested.
if SYM_OLD and SYM_NEW:
    if not os.path.exists(SYM_NEW):
        die(2, f'symlink target does not exist: {SYM_NEW}')
    if os.path.islink(SYM_OLD):
        actual = os.readlink(SYM_OLD)
        if actual != SYM_NEW:
            sys.stderr.write(f'[hapi-resurrect-session] warn: {SYM_OLD} already symlinks to {actual} (wanted {SYM_NEW})\n')
        else:
            sys.stderr.write(f'[hapi-resurrect-session] symlink ok: {SYM_OLD} -> {SYM_NEW}\n')
    elif os.path.isdir(SYM_OLD) and not os.listdir(SYM_OLD):
        if DRY:
            sys.stderr.write(f'[hapi-resurrect-session] DRY: would replace empty dir {SYM_OLD} with symlink -> {SYM_NEW}\n')
        else:
            os.rmdir(SYM_OLD)
            os.symlink(SYM_NEW, SYM_OLD)
            sys.stderr.write(f'[hapi-resurrect-session] symlinked: {SYM_OLD} -> {SYM_NEW}\n')
    elif os.path.exists(SYM_OLD):
        die(2, f'cannot symlink: {SYM_OLD} exists and is not empty/symlink')

# Patch metadata.
before = {
    'lifecycleState': md.get('lifecycleState'),
    'cursorSessionId': md.get('cursorSessionId'),
    'cursorSessionProtocol': md.get('cursorSessionProtocol'),
    'path': metadata_path,
    'name': md.get('name'),
    'archivedBy': md.get('archivedBy'),
    'archiveReason': md.get('archiveReason'),
}
md['cursorSessionId'] = CURSOR
md['cursorSessionProtocol'] = 'stream-json'
md['lifecycleState'] = 'inactive'
md['lifecycleStateSince'] = int(time.time() * 1000)
md.pop('archivedBy', None)
md.pop('archiveReason', None)
if NAME:
    md['name'] = NAME
# If discovery succeeded with an alt path, point metadata.path at that
# (so cursor-agent finds its workspace-keyed chat store).
if discovered_path and discovered_path != metadata_path:
    md['path'] = discovered_path
    if isinstance(md.get('worktree'), dict):
        md['worktree']['worktreePath'] = discovered_path

new_v = mver + 1
plan = {
    'sessionId': sid,
    'cursorUuid': CURSOR,
    'before': before,
    'after': {
        'lifecycleState': md['lifecycleState'],
        'cursorSessionId': md['cursorSessionId'],
        'cursorSessionProtocol': md['cursorSessionProtocol'],
        'path': md['path'],
        'name': md.get('name'),
    },
    'metadata_version': f'{mver} -> {new_v}',
    'dryRun': DRY,
}
print(json.dumps(plan, indent=2))

if DRY:
    sys.exit(0)

con.execute(
    'UPDATE sessions SET metadata=?, metadata_version=? WHERE id=?',
    (json.dumps(md), new_v, sid),
)
con.commit()
con.close()
sys.stderr.write('[hapi-resurrect-session] metadata patched.\n')
PY
}

PLAN_JSON=$(run_py)
echo "$PLAN_JSON"

if [[ "$DRY" -eq 1 ]]; then
    echo "[hapi-resurrect-session] dry-run complete."
    exit 0
fi

if [[ "$NO_RESTART" -eq 0 ]]; then
    echo "[hapi-resurrect-session] restarting hub so metadata cache reloads..."
    hapi-restart-hub
    for i in $(seq 1 15); do
        if curl -fsS "$HUB/" >/dev/null 2>&1; then break; fi
        sleep 1
    done
    sleep 3
fi

JWT=$(curl -fsS -X POST "$HUB/api/auth" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json; s=json.load(open('$SETTINGS')); print(json.dumps({'accessToken': s['cliApiToken']}))")" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Get the actual full session ID from the plan json (in case caller passed prefix)
FULL_SID=$(echo "$PLAN_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')

echo "[hapi-resurrect-session] POST /api/sessions/$FULL_SID/resume ..."
RESUME_BODY=$(curl -sS -X POST "$HUB/api/sessions/$FULL_SID/resume" \
    -H "Authorization: Bearer $JWT" \
    -H 'Content-Type: application/json' \
    -d '{}')
echo "$RESUME_BODY" | python3 -m json.tool 2>/dev/null || echo "$RESUME_BODY"
NEW_SID=$(echo "$RESUME_BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("sessionId",""))' 2>/dev/null || true)
if [[ -z "$NEW_SID" ]]; then
    echo "[hapi-resurrect-session] resume did not return a sessionId; check error above"
    exit 3
fi

echo "[hapi-resurrect-session] resurrected: original=$FULL_SID  live=$NEW_SID"
echo "[hapi-resurrect-session] verifying live session in 8s..."
sleep 8

LIVE_STATE=$(sqlite3 "$DB" "SELECT json_extract(metadata, '\$.lifecycleState') FROM sessions WHERE id='$NEW_SID'")
LIVE_PROTO=$(sqlite3 "$DB" "SELECT json_extract(metadata, '\$.cursorSessionProtocol') FROM sessions WHERE id='$NEW_SID'")
LIVE_MSGS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE session_id='$NEW_SID'")
echo "[hapi-resurrect-session] live session $NEW_SID: lifecycleState=$LIVE_STATE protocol=$LIVE_PROTO messages=$LIVE_MSGS"

if [[ "$LIVE_STATE" == "archived" ]]; then
    echo "[hapi-resurrect-session] WARN: live session was re-archived within 8s (cursor-agent likely crashed)"
    echo "[hapi-resurrect-session]       check ~/.hapi/logs/ for the spawned PID log"
    exit 4
fi

# Chain forward into PR #34 (auto-migrate). After resurrect the session is
# back to lifecycleState=inactive with cursorSessionProtocol=stream-json by
# design (the legacy launcher knows how to dispatch the stream-json store).
# Once heavygee/hapi#34 lands, SyncEngine.resumeSession fires
# maybeAutoMigrateLegacyCursorSession automatically on the operator's NEXT
# Reopen — so resurrect + Reopen is the full crash-to-ACP chain with no
# manual migrate command required.
if [[ "$LIVE_PROTO" == "acp" ]]; then
    echo "[hapi-resurrect-session] session is already on ACP. No further action needed."
elif [[ "$LIVE_PROTO" == "stream-json" ]]; then
    echo "[hapi-resurrect-session] session is on legacy stream-json."
    echo "[hapi-resurrect-session]   next: open this session in the HAPI web UI and click Reopen."
    echo "[hapi-resurrect-session]   once heavygee/hapi#34 (tiann/hapi#824) auto-migrate is live, that"
    echo "[hapi-resurrect-session]   Reopen will transparently transplant this session to ACP"
    echo "[hapi-resurrect-session]   (cp store.db, verify session/load, flip protocol; ~15-20s banner)."
    echo "[hapi-resurrect-session]   kill-switch: HAPI_CURSOR_LEGACY_AUTO_MIGRATE=0 in hub env."
fi

echo "[hapi-resurrect-session] DONE. Open in HAPI web UI: session id $NEW_SID"
