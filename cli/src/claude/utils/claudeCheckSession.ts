import { logger } from "@/ui/logger";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getProjectPath } from "./path";

function encodeProjectId(workingDirectory: string): string {
    return resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeProjectsRoot(home?: string): string {
    if (process.env.CLAUDE_CONFIG_DIR) {
        return join(process.env.CLAUDE_CONFIG_DIR, 'projects');
    }
    return join(home || homedir(), '.claude', 'projects');
}

function lineHasUuid(line: string): boolean {
    if (!line.trim()) return false;
    try {
        return typeof JSON.parse(line).uuid === 'string';
    } catch {
        return false;
    }
}

/** Cap probe read so huge transcripts cannot stall the runner RPC thread. */
const TRANSCRIPT_PROBE_MAX_BYTES = 2 * 1024 * 1024;

function transcriptLooksValid(sessionFile: string): boolean {
    if (!existsSync(sessionFile)) {
        return false;
    }
    try {
        const fd = openSync(sessionFile, 'r');
        try {
            const buf = Buffer.alloc(64 * 1024);
            let offset = 0;
            let leftover = '';
            while (offset < TRANSCRIPT_PROBE_MAX_BYTES) {
                const bytesRead = readSync(fd, buf, 0, buf.length, offset);
                if (bytesRead <= 0) break;
                offset += bytesRead;
                const chunk = leftover + buf.toString('utf-8', 0, bytesRead);
                const lines = chunk.split('\n');
                // Always keep the final segment in leftover — at EOF it may be
                // a complete JSONL row with no trailing newline.
                leftover = lines.pop() ?? '';
                for (const line of lines) {
                    if (lineHasUuid(line)) return true;
                }
                if (bytesRead < buf.length) break;
            }
            if (lineHasUuid(leftover)) return true;
            // Hit the byte cap without a complete UUID-bearing row: the file
            // exists and is huge — treat as present rather than missing so a
            // oversized first line does not cause false resume_unavailable.
            if (offset >= TRANSCRIPT_PROBE_MAX_BYTES) {
                return true;
            }
            return false;
        } finally {
            closeSync(fd);
        }
    } catch {
        return false;
    }
}

function candidateProjectDirs(workspacePath: string, home?: string): string[] {
    const projectsRoot = claudeProjectsRoot(home);
    const dirs = new Set<string>();
    // getProjectPath respects CLAUDE_CONFIG_DIR; when probing a recorded home
    // without mutating env, build the slug under that home explicitly.
    if (home && !process.env.CLAUDE_CONFIG_DIR) {
        dirs.add(join(projectsRoot, encodeProjectId(workspacePath)));
    } else {
        dirs.add(getProjectPath(workspacePath));
    }

    try {
        const real = realpathSync(workspacePath);
        if (real !== resolve(workspacePath)) {
            dirs.add(join(projectsRoot, encodeProjectId(real)));
        }
    } catch {
        // workspace may not exist yet — keep the resolved slug only
    }

    return [...dirs];
}

/**
 * On-disk probe for a Claude Code transcript (Cursor #841 spirit).
 * Checks the workspace project slug, a realpath alternate when different,
 * then a cross-project scan under ~/.claude/projects (Claude CLI does the
 * same for --resume by UUID).
 */
export function inspectClaudeTranscript(opts: {
    sessionId: string
    workspacePath: string
    home?: string
}): { onDisk: boolean } {
    const sessionId = opts.sessionId.trim();
    if (!sessionId || sessionId === '.' || sessionId === '..' || sessionId.includes('/') || sessionId.includes('\\')) {
        return { onDisk: false };
    }

    for (const projectDir of candidateProjectDirs(opts.workspacePath, opts.home)) {
        const sessionFile = join(projectDir, `${sessionId}.jsonl`);
        if (transcriptLooksValid(sessionFile)) {
            return { onDisk: true };
        }
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist or lacks uuid lines`);
    }

    // Cross-project: Claude --resume <uuid> searches every project drawer.
    const projectsRoot = claudeProjectsRoot(opts.home);
    try {
        for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const sessionFile = join(projectsRoot, entry.name, `${sessionId}.jsonl`);
            if (transcriptLooksValid(sessionFile)) {
                logger.debug(`[claudeCheckSession] Found ${sessionId} under cross-project drawer ${entry.name}`);
                return { onDisk: true };
            }
        }
    } catch {
        // projects root missing
    }

    return { onDisk: false };
}

export function claudeCheckSession(sessionId: string, path: string): boolean {
    return inspectClaudeTranscript({ sessionId, workspacePath: path }).onDisk;
}
