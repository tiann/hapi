// Process-wide monotonic epoch bumped whenever a session row is deleted.
//
// Per-socket session-access memos (socket/handlers/cli) stamp the epoch they
// were filled under and re-resolve on mismatch, so a deletion takes effect on
// the very next event instead of after the memo TTL — inside that window a
// stale grant would keep authorizing events (and FK-failing writes) against a
// row that no longer exists. Reading the epoch is a single integer compare;
// bumps are rare (user-initiated deletes, session merges).
let epoch = 0

export function bumpSessionDeletionEpoch(): void {
    epoch += 1
}

export function sessionDeletionEpoch(): number {
    return epoch
}
