import { logger } from "@/ui/logger";
import { existsSync, readFileSync } from "node:fs";
import { getProjectPath } from "./path";
import { findClaudeSessionFileSync } from "./transcriptEntry";

export function claudeCheckSession(sessionId: string, path: string) {
    const projectDir = getProjectPath(path);

    // Claude Code relocates the transcript into the cwd's project dir when the
    // session enters or leaves a git worktree, so resolve across project dirs
    // instead of trusting the launch dir alone.
    const sessionFile = findClaudeSessionFileSync(sessionId, { projectDir });
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    // Check if session contains any messages
    const sessionData = readFileSync(sessionFile, 'utf-8').split('\n');
    const hasGoodMessage = !!sessionData.find((v) => {
        try {
            return typeof JSON.parse(v).uuid === 'string'
        } catch (e) {
            return false;
        }
    });

    return hasGoodMessage;
}