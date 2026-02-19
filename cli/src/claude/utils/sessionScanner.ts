import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { getProjectPath } from "./path";
import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export async function createSessionScanner(opts: {
    sessionId: string | null;
    workingDirectory: string;
    onMessage: (message: RawJSONLines) => void;
}) {
    const scanner = new ClaudeSessionScanner({
        sessionId: opts.sessionId,
        workingDirectory: opts.workingDirectory,
        onMessage: opts.onMessage
    });

    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (sessionId: string) => {
            scanner.onNewSession(sessionId);
        }
    };
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


class ClaudeSessionScanner extends BaseSessionScanner<RawJSONLines> {
    private readonly projectDir: string;
    private readonly onMessage: (message: RawJSONLines) => void;
    private readonly finishedSessions = new Set<string>();
    private readonly pendingSessions = new Set<string>();
    private currentSessionId: string | null;
    private readonly scannedSessions = new Set<string>();

    constructor(opts: { sessionId: string | null; workingDirectory: string; onMessage: (message: RawJSONLines) => void }) {
        super({ intervalMs: 3000 });
        this.projectDir = getProjectPath(opts.workingDirectory);
        this.onMessage = opts.onMessage;
        this.currentSessionId = opts.sessionId;
    }

    public onNewSession(sessionId: string): void {
        if (this.currentSessionId === sessionId) {
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
            return;
        }
        if (this.finishedSessions.has(sessionId)) {
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
            return;
        }
        if (this.pendingSessions.has(sessionId)) {
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
            return;
        }
        if (this.currentSessionId) {
            this.pendingSessions.add(this.currentSessionId);
        }
        logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`);
        this.currentSessionId = sessionId;
        this.invalidate();
    }

    protected async initialize(): Promise<void> {
        if (!this.currentSessionId) {
            return;
        }
        const sessionFile = this.sessionFilePath(this.currentSessionId);
        const { events, totalLines } = await readSessionLog(sessionFile, 0);
        logger.debug(`[SESSION_SCANNER] Marking ${events.length} existing messages as processed from session ${this.currentSessionId}`);
        const keys = events.map((entry) => messageKey(entry.event));
        this.seedProcessedKeys(keys);
        this.setCursor(sessionFile, totalLines);
    }

    protected async beforeScan(): Promise<void> {
        this.scannedSessions.clear();
    }

    protected async findSessionFiles(): Promise<string[]> {
        const files = new Set<string>();
        for (const sessionId of this.pendingSessions) {
            files.add(this.sessionFilePath(sessionId));
        }
        if (this.currentSessionId && !this.pendingSessions.has(this.currentSessionId)) {
            files.add(this.sessionFilePath(this.currentSessionId));
        }
        for (const watched of this.getWatchedFiles()) {
            files.add(watched);
        }
        return [...files];
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<RawJSONLines>> {
        const sessionId = sessionIdFromPath(filePath);
        if (sessionId) {
            this.scannedSessions.add(sessionId);
        }
        const { events, totalLines } = await readSessionLog(filePath, cursor);
        if (events.length > 0) {
            logger.debug(`[SESSION_SCANNER] Read ${events.length} new event(s) from session file: ${filePath}`);
        }
        return {
            events,
            nextCursor: totalLines
        };
    }

    protected generateEventKey(event: RawJSONLines): string {
        return messageKey(event);
    }

    protected async handleFileScan(stats: SessionFileScanStats<RawJSONLines>): Promise<void> {
        for (const message of stats.events) {
            const id = message.type === 'summary' ? message.leafUuid : message.uuid;
            logger.debug(`[SESSION_SCANNER] Sending new message: type=${message.type}, uuid=${id}`);
            this.onMessage(message);
        }
        if (stats.parsedCount > 0) {
            const sessionId = sessionIdFromPath(stats.filePath) ?? 'unknown';
            logger.debug(`[SESSION_SCANNER] Session ${sessionId}: found=${stats.parsedCount}, skipped=${stats.skippedCount}, sent=${stats.newCount}`);
        }
    }

    protected async afterScan(): Promise<void> {
        for (const sessionId of this.scannedSessions) {
            if (this.pendingSessions.has(sessionId)) {
                this.pendingSessions.delete(sessionId);
                this.finishedSessions.add(sessionId);
            }
        }
    }

    private sessionFilePath(sessionId: string): string {
        return join(this.projectDir, `${sessionId}.jsonl`);
    }
}

//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Read and parse session log file.
 * Returns only valid conversation messages, silently skipping internal events.
 */
async function readSessionLog(filePath: string, startLine: number): Promise<{ events: SessionFileScanEntry<RawJSONLines>[]; totalLines: number }> {
    let file: string;
    try {
        file = await readFile(filePath, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${filePath}`);
        return { events: [], totalLines: startLine };
    }
    const lines = file.split('\n');
    const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
    let effectiveStartLine = startLine;
    if (effectiveStartLine > totalLines) {
        effectiveStartLine = 0;
    }
    const messages: SessionFileScanEntry<RawJSONLines>[] = [];
    for (let index = effectiveStartLine; index < lines.length; index += 1) {
        const l = lines[index];
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped.
                continue;
            }
            messages.push({ event: parsed.data, lineIndex: index });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return { events: messages, totalLines };
}

function sessionIdFromPath(filePath: string): string | null {
    const base = basename(filePath);
    if (!base.endsWith('.jsonl')) {
        return null;
    }
    return base.slice(0, -'.jsonl'.length);
}
