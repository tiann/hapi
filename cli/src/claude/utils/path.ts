import { homedir } from "node:os";
import { join, resolve, win32, posix } from "node:path";

export function getProjectPath(workingDirectory: string) {
    let resolvedPath = resolve(workingDirectory);

    // On Windows, remove the drive letter (e.g., "C:" or "D:") from resolved paths.
    // This ensures that:
    // 1. Unix-style paths like "/Users/..." don't get polluted with drive letters
    // 2. Windows absolute paths like "D:\MyTools\..." are handled consistently
    // Note: This means paths on different drives with the same structure will have
    // the same project ID, but this is acceptable since project paths are typically
    // consistent within a development environment.
    if (process.platform === 'win32' && /^[a-zA-Z]:/.test(resolvedPath)) {
        resolvedPath = resolvedPath.substring(2); // Remove "C:" or "D:" etc.
    }

    const projectId = resolvedPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}