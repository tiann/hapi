import fs from 'fs/promises';

/**
 * Result of validating (and optionally creating) a workspace directory before
 * a session is spawned at it.
 *
 *  - `ok`: the directory exists (or was just created) and is usable as a cwd.
 *    `created` distinguishes the just-created case so the runner can surface a
 *    user-visible "we created this folder for you" message.
 *  - `requestApproval`: the path does not exist and the caller has not approved
 *    new-directory creation. Surfaces back to the web UI as the existing
 *    `requestToApproveDirectoryCreation` flow.
 *  - `error`: validation failed. `errorMessage` is the user-facing string and
 *    is preferred over leaking raw kernel errors (EEXIST etc.).
 */
export type ValidateWorkspaceDirectoryResult =
    | { type: 'ok'; created: boolean }
    | { type: 'requestApproval' }
    | { type: 'error'; errorMessage: string };

export interface ValidateWorkspaceDirectoryOptions {
    approvedNewDirectoryCreation: boolean;
}

/**
 * Resolve a workspace directory before spawning a session at it.
 *
 * Replaces the historic `fs.access` + `fs.mkdir({ recursive: true })` pair in
 * `run.ts`, which produced a misleading EEXIST error on dangling symlinks
 * (symlink points at a deleted target, `fs.access` follows the link and
 * throws ENOENT, then `mkdir` cannot tolerate the existing non-directory
 * entry and surfaces `EEXIST: file already exists, mkdir '...'` to the user).
 *
 * The replacement uses `fs.lstat` so symlinks are inspected without being
 * followed, distinguishes dangling symlinks from genuinely missing paths and
 * from regular files squatting at the workspace path, and only attempts
 * `mkdir` when the path truly does not exist.
 */
export async function validateWorkspaceDirectory(
    directory: string,
    options: ValidateWorkspaceDirectoryOptions
): Promise<ValidateWorkspaceDirectoryResult> {
    const { approvedNewDirectoryCreation } = options;

    let lstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
        lstat = await fs.lstat(directory);
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            // path does not exist - fall through to mkdir / approval flow
        } else if (err?.code === 'ENOTDIR') {
            // Parent path contains a regular file; preserve the historic
            // mkdir ENOTDIR diagnostic instead of the generic inspect text.
            return {
                type: 'error',
                errorMessage: describeMkdirError(directory, err),
            };
        } else {
            return {
                type: 'error',
                errorMessage:
                    `Unable to inspect workspace path '${directory}'. ` +
                    `System error: ${err?.message || err}. ` +
                    `Please verify the path is valid and you have the necessary permissions.`,
            };
        }
    }

    if (lstat) {
        if (lstat.isSymbolicLink()) {
            return await handleSymlink(directory);
        }
        if (lstat.isDirectory()) {
            return { type: 'ok', created: false };
        }
        return {
            type: 'error',
            errorMessage:
                `A non-directory file already exists at '${directory}'. ` +
                `Cannot use it as a workspace. Please move or remove the file, or pick a different workspace path.`,
        };
    }

    if (!approvedNewDirectoryCreation) {
        return { type: 'requestApproval' };
    }

    try {
        await fs.mkdir(directory, { recursive: true });
        return { type: 'ok', created: true };
    } catch (err: any) {
        return await buildMkdirError(directory, err);
    }
}

async function handleSymlink(directory: string): Promise<ValidateWorkspaceDirectoryResult> {
    let linkTarget = '';
    try {
        linkTarget = await fs.readlink(directory);
    } catch {
        // Best-effort: if we can't read the link, we still report a useful error below.
    }

    let realPath: string;
    try {
        realPath = await fs.realpath(directory);
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            const targetDescription = linkTarget
                ? `'${linkTarget}'`
                : 'a target that no longer exists';
            // Deliberately do NOT embed `directory` inside a copy-pasteable
            // shell command (e.g. `rm '...'`): a path containing a single
            // quote would break the quoting and turn this diagnostic into
            // a shell-injection / accidental-delete vector. Describe the
            // recovery action in prose instead. (Codex review on PR #892.)
            return {
                type: 'error',
                errorMessage:
                    `Workspace path '${directory}' is a symbolic link to ${targetDescription}, ` +
                    `which no longer exists. This usually means the target was deleted ` +
                    `(e.g. via \`git worktree remove\`) without removing the symlink. ` +
                    `Recovery: recreate the directory at the target path, remove the dangling symlink at '${directory}', ` +
                    `or archive this session.`,
            };
        }
        return {
            type: 'error',
            errorMessage:
                `Unable to resolve symbolic link at '${directory}'. ` +
                `System error: ${err?.message || err}. ` +
                `Please verify the symlink target is reachable and you have the necessary permissions.`,
        };
    }

    let resolvedStat;
    try {
        resolvedStat = await fs.stat(realPath);
    } catch (err: any) {
        return {
            type: 'error',
            errorMessage:
                `Unable to stat resolved path '${realPath}' (symlinked from '${directory}'). ` +
                `System error: ${err?.message || err}.`,
        };
    }

    if (resolvedStat.isDirectory()) {
        return { type: 'ok', created: false };
    }

    return {
        type: 'error',
        errorMessage:
            `Workspace path '${directory}' is a symbolic link to '${realPath}', which is not a directory. ` +
            `Please update the symlink to point at a directory, or pick a different workspace path.`,
    };
}

/**
 * Pure mapping of `mkdir` errno codes to user-facing messages. Exported for
 * unit tests; production callers go through `buildMkdirError` which adds
 * `EEXIST` race-handling on top.
 */
export function describeMkdirError(
    directory: string,
    err: { code?: string; message?: string } | undefined | null
): string {
    const prefix = `Unable to create directory at '${directory}'. `;
    switch (err?.code) {
        case 'EACCES':
            return (
                prefix +
                `Permission denied. You don't have write access to create a folder at this location. ` +
                `Try using a different path or check your permissions.`
            );
        case 'ENOTDIR':
            return (
                prefix +
                `A file already exists at this path or in the parent path. ` +
                `Cannot create a directory here. Please choose a different location.`
            );
        case 'ENOSPC':
            return (
                prefix +
                `No space left on device. Your disk is full. Please free up some space and try again.`
            );
        case 'EROFS':
            return (
                prefix +
                `The file system is read-only. Cannot create directories here. Please choose a writable location.`
            );
        case 'EEXIST':
            return (
                prefix +
                `A non-directory file appeared at this path between the existence check ` +
                `and directory creation. Please move or remove it, or pick a different path.`
            );
        default:
            return (
                prefix +
                `System error: ${err?.message || err}. ` +
                `Please verify the path is valid and you have the necessary permissions.`
            );
    }
}

async function buildMkdirError(
    directory: string,
    err: any
): Promise<ValidateWorkspaceDirectoryResult> {
    if (err?.code === 'EEXIST') {
        // Race with a parallel writer between the initial lstat and mkdir, OR
        // a non-directory entry that mkdir({ recursive: true }) refused to
        // tolerate. lstat the path again to produce a targeted message
        // instead of leaking the kernel error verbatim.
        try {
            const raceStat = await fs.lstat(directory);
            if (raceStat.isDirectory()) {
                // mkdir({ recursive: true }) should not throw EEXIST on an
                // existing directory; if it did, treat the directory as good
                // enough rather than failing the user.
                return { type: 'ok', created: false };
            }
            if (raceStat.isSymbolicLink()) {
                return handleSymlink(directory);
            }
        } catch {
            // Fall through to the message-only path below if we can't even
            // lstat the path again (very unusual race).
        }
    }
    return {
        type: 'error',
        errorMessage: describeMkdirError(directory, err),
    };
}
