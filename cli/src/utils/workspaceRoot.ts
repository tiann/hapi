import { isAbsolute } from 'node:path'

/**
 * Resolves the runner's workspace root — the directory tree the runner is
 * allowed to browse and spawn sessions in. Returns `undefined` when the
 * user hasn't explicitly opted in; in that case the runner behaves like
 * the legacy hapi (no scoping, no /browse feature surfaced in the web UI).
 *
 * The only signal is the `explicit` argument — typically the resolved
 * `--workspace-root` flag. Non-absolute values are ignored.
 */
export function resolveWorkspaceRoot(explicit?: string): string | undefined {
    if (explicit && isAbsolute(explicit)) {
        return explicit
    }
    return undefined
}
