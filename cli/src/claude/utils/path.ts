import { homedir } from "node:os";
import { join, resolve, win32, posix } from "node:path";

export function getProjectPath(workingDirectory: string) {
    let resolvedPath = resolve(workingDirectory);

    // On Windows, preserve the drive letter but remove the colon to avoid it becoming
    // part of the project ID in an invalid way, while still distinguishing between
    // different drives (e.g., "D:\MyTools\hapi" vs "C:\MyTools\hapi")
    if (process.platform === 'win32' && /^[a-zA-Z]:/.test(resolvedPath)) {
        const driveLetter = resolvedPath.charAt(0); // Extract 'D' or 'C' etc.
        resolvedPath = driveLetter + resolvedPath.substring(2); // D:\MyTools\hapi → D\MyTools\hapi
    }

    const projectId = resolvedPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}