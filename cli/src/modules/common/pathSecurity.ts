import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface PathValidationResult {
    valid: boolean
    resolvedPath?: string
    error?: string
}

export interface PathValidationOptions {
    allowMissingLeaf?: boolean
    allowMissingDescendants?: boolean
}

function normalizeForComparison(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
}

function isWithinPath(candidate: string, root: string): boolean {
    const normalizedCandidate = normalizeForComparison(candidate)
    const normalizedRoot = normalizeForComparison(root)
    const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootPrefix)
}

function denied(targetPath: string, reason: string): PathValidationResult {
    return {
        valid: false,
        error: `Access denied: Path '${targetPath}' ${reason}`,
    }
}

/**
 * Resolves a requested path against the real session workspace and rejects every
 * symlink component below that workspace. Existing targets must exist; callers
 * creating a file may allow only the final leaf to be missing.
 */
export async function validatePath(
    targetPath: string,
    workingDirectory: string,
    options: PathValidationOptions = {},
): Promise<PathValidationResult> {
    if (typeof targetPath !== 'string' || typeof workingDirectory !== 'string') {
        return denied(String(targetPath), 'is invalid')
    }

    const lexicalWorkingDirectory = resolve(workingDirectory)
    let realWorkingDirectory: string
    try {
        realWorkingDirectory = await realpath(lexicalWorkingDirectory)
    } catch {
        return denied(targetPath, 'cannot be resolved because the working directory is unavailable')
    }

    const lexicalTarget = resolve(lexicalWorkingDirectory, targetPath)
    let workspaceRelativePath: string
    if (isWithinPath(lexicalTarget, lexicalWorkingDirectory)) {
        workspaceRelativePath = relative(lexicalWorkingDirectory, lexicalTarget)
    } else if (isWithinPath(lexicalTarget, realWorkingDirectory)) {
        workspaceRelativePath = relative(realWorkingDirectory, lexicalTarget)
    } else {
        return denied(targetPath, 'is outside the working directory')
    }

    if (isAbsolute(workspaceRelativePath) || workspaceRelativePath === '..' || workspaceRelativePath.startsWith(`..${sep}`)) {
        return denied(targetPath, 'is outside the working directory')
    }

    const components = workspaceRelativePath.split(sep).filter(Boolean)
    let currentPath = realWorkingDirectory

    for (const [index, component] of components.entries()) {
        const candidatePath = join(currentPath, component)
        const isLeaf = index === components.length - 1
        try {
            const stats = await lstat(candidatePath)
            if (stats.isSymbolicLink()) {
                return denied(targetPath, 'contains a symbolic link')
            }
            if (!isLeaf && !stats.isDirectory()) {
                return denied(targetPath, 'contains a non-directory parent')
            }
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException
            if (nodeError.code === 'ENOENT' && options.allowMissingDescendants) {
                return {
                    valid: true,
                    resolvedPath: join(candidatePath, ...components.slice(index + 1)),
                }
            }
            if (nodeError.code === 'ENOENT' && isLeaf && options.allowMissingLeaf) {
                return { valid: true, resolvedPath: candidatePath }
            }
            return denied(targetPath, 'does not exist')
        }
        currentPath = candidatePath
    }

    let realTarget: string
    try {
        realTarget = await realpath(currentPath)
    } catch {
        return denied(targetPath, 'does not exist')
    }

    if (!isWithinPath(realTarget, realWorkingDirectory)) {
        return denied(targetPath, 'resolves outside the working directory')
    }

    return { valid: true, resolvedPath: realTarget }
}
