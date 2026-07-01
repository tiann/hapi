import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { basename, join } from "node:path";
import { open, stat } from "node:fs/promises";
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
        },
        // Call when the user submits input so the scanner polls fast right away
        // (rather than waiting up to the idle interval for the first response).
        markActive: () => {
            scanner.markActive();
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
        // fs.watch (in BaseSessionScanner.ensureWatcher) drives near-real-time
        // updates; the poll is a fallback for missed watch events. Adaptive: 5s
        // while idle (cheap — a stat, then an incremental read of only new
        // bytes), 100ms while a response/tool-call is active or just after user
        // input, dropping back after 3s of quiet.
        super({ intervalMs: 5000, activeIntervalMs: 100, activeWindowMs: 3000 });
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
        const { events, nextCursor } = await readSessionLog(sessionFile, 0);
        logger.debug(`[SESSION_SCANNER] Marking ${events.length} existing messages as processed from session ${this.currentSessionId}`);
        const keys = events.map((entry) => messageKey(entry.event));
        this.seedProcessedKeys(keys);
        this.setCursor(sessionFile, nextCursor);
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
        const { events, nextCursor } = await readSessionLog(filePath, cursor);
        return {
            events,
            nextCursor
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
 * Incrementally read and parse a session log file.
 *
 * The cursor is a BYTE OFFSET into the (append-only) JSONL. Each scan stats the
 * file and reads only the bytes after the cursor — so the cost is O(new content)
 * regardless of how large the conversation has grown, instead of re-reading the
 * whole file every poll. A trailing partial line (a write in progress) is left
 * unconsumed until its newline arrives. If the file shrank (compaction rewrote
 * it), the cursor resets to 0 and the whole file is re-read (dedup by uuid in the
 * base scanner absorbs any re-sent events).
 */
async function readSessionLog(filePath: string, startByte: number): Promise<{ events: SessionFileScanEntry<RawJSONLines>[]; nextCursor: number }> {
    let size: number;
    try {
        size = (await stat(filePath)).size;
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${filePath}`);
        return { events: [], nextCursor: startByte };
    }

    let from = startByte;
    if (from > size) {
        from = 0; // file was truncated/rewritten — re-read from the top
    }
    if (from >= size) {
        return { events: [], nextCursor: size }; // no new bytes
    }

    let chunk: Buffer;
    const fd = await open(filePath, 'r');
    try {
        const length = size - from;
        const buffer = Buffer.allocUnsafe(length);
        // fd.read may return fewer bytes than requested even for a regular file;
        // the tail of an allocUnsafe buffer is uninitialized heap, so only the
        // first `bytesRead` bytes are valid. Operating past them would let a stray
        // 0x0a in garbage advance the cursor past never-read data → dropped lines.
        const { bytesRead } = await fd.read(buffer, 0, length, from);
        chunk = buffer.subarray(0, bytesRead);
    } finally {
        await fd.close();
    }

    // Consume only through the last newline; keep any trailing partial line for
    // the next scan (`from` always sits on a line boundary, so the chunk's first
    // line is always complete).
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) {
        return { events: [], nextCursor: from };
    }
    const nextCursor = from + lastNewline + 1;
    const text = chunk.subarray(0, lastNewline).toString('utf-8');

    const messages: SessionFileScanEntry<RawJSONLines>[] = [];
    for (const l of text.split('\n')) {
        if (l.trim() === '') {
            continue;
        }
        try {
            const message = JSON.parse(l);
            // Silently skip known internal Claude Code state/tracking events.
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }
            const parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped.
                continue;
            }
            messages.push({ event: parsed.data });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return { events: messages, nextCursor };
}

function sessionIdFromPath(filePath: string): string | null {
    const base = basename(filePath);
    if (!base.endsWith('.jsonl')) {
        return null;
    }
    return base.slice(0, -'.jsonl'.length);
}
