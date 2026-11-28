import { isObject } from '@hapi/protocol'

function patchDiff(change: unknown): string | null {
    if (!isObject(change)) return null
    // Legacy patch events carry unified_diff. App-server "diff" is a hunk
    // for updates, but the literal file contents for additions and deletions.
    const kind = isObject(change.kind) ? change.kind.type : change.type
    if (kind !== 'update') return null
    const diff = change.unified_diff ?? change.diff
    return typeof diff === 'string' && diff.trim() ? diff : null
}

export function codexPatchFiles(input: unknown): { path: string; diff: string | null }[] {
    if (!isObject(input) || !isObject(input.changes)) return []
    if (Array.isArray(input.changes)) {
        return input.changes.flatMap(change =>
            isObject(change) && typeof change.path === 'string' && change.path
                ? [{ path: change.path, diff: patchDiff(change) }]
                : [])
    }
    return Object.entries(input.changes).map(([path, change]) => ({ path, diff: patchDiff(change) }))
}
