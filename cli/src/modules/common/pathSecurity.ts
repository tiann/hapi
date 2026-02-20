import { realpath } from 'fs/promises'
import { dirname, resolve, sep } from 'path'

export interface PathValidationResult {
    valid: boolean;
    error?: string;
}

function normalizePath(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
}

function isPathWithinDirectory(targetPath: string, rootDirectory: string): boolean {
    const normalizedTarget = normalizePath(targetPath)
    const normalizedRoot = normalizePath(rootDirectory)
    const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootPrefix)
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // This prevents access to files outside the working directory
    if (!isPathWithinDirectory(resolvedTarget, resolvedWorkingDir)) {
        return {
            valid: false,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true };
}

/**
 * Validates a resolved path against the real filesystem path to prevent
 * symlink traversal outside the working directory.
 */
export async function validateRealPath(
    resolvedPath: string,
    workingDirectory: string
): Promise<PathValidationResult> {
    let realWorkingDir: string
    try {
        realWorkingDir = await realpath(workingDirectory)
    } catch {
        realWorkingDir = resolve(workingDirectory)
    }

    let probePath = resolvedPath

    while (true) {
        try {
            const realTarget = await realpath(probePath)
            if (!isPathWithinDirectory(realTarget, realWorkingDir)) {
                return {
                    valid: false,
                    error: 'Access denied: symlink traversal outside working directory'
                }
            }

            return { valid: true }
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException
            if (nodeError.code !== 'ENOENT') {
                return {
                    valid: false,
                    error: 'Cannot resolve path'
                }
            }

            const parentPath = dirname(probePath)
            if (parentPath === probePath) {
                return { valid: true }
            }

            probePath = parentPath
        }
    }
}
