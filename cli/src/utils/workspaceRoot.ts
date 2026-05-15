import { isAbsolute } from 'node:path'

/**
 * Resolves the runner's workspace roots — the directory trees the runner is
 * allowed to browse and spawn sessions in. Returns `undefined` when the
 * user hasn't explicitly opted in; in that case the runner behaves like
 * legacy hapi (no scoping, no /browse feature surfaced in the web UI).
 *
 * The only signal is the `explicit` argument — typically the resolved
 * `--workspace-root` flag values. Non-absolute values are ignored.
 */
export function resolveWorkspaceRoots(explicit?: string[]): string[] | undefined {
    if (!explicit?.length) {
        return undefined
    }

    const uniqueRoots = Array.from(
        new Set(explicit.filter((path): path is string => typeof path === 'string' && isAbsolute(path)))
    )

    return uniqueRoots.length > 0 ? uniqueRoots : undefined
}
