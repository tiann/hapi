import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getClaudeProjectsDir() {
    return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, '-');
    return join(getClaudeProjectsDir(), projectId);
}
