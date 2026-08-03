import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from '@/modules/common/session/BaseSessionScanner';
import { logger } from '@/ui/logger';
import { convertCodexEvent, type CodexSessionEvent } from './codexEventConverter';
import {
    createReplayUsageAccumulator,
    noteReplayUsageSampleIfAbsent,
    orderedReplayUsagePayloads,
    type ReplayUsageAccumulator
} from './codexUsage';

const DEFAULT_USAGE_TAIL_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_USAGE_TAIL_READ_CHUNK_BYTES = 64 * 1024;

interface CodexSessionScannerOptions {
    transcriptPath: string | null;
    onEvent: (event: CodexSessionEvent, context: { replayedHistory: boolean }) => void;
    onSessionId?: (sessionId: string) => void;
    replayExistingHistory?: boolean;
    /** When set (and not replaying history), start watching at this byte offset without reading prior bytes. */
    initialCursor?: number;
}

export type ReadLatestCodexUsageFromTailOptions = {
    maxBytes?: number;
    chunkBytes?: number;
    threadId?: string;
};

export interface CodexSessionScanner {
    flush: () => Promise<void>;
    cleanup: () => Promise<void>;
    setTranscriptPath: (transcriptPath: string) => Promise<void>;
}

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const scanner = new CodexSessionScannerImpl(opts);
    await scanner.start();

    return {
        flush: async () => {
            await scanner.flush();
        },
        cleanup: async () => {
            await scanner.cleanup();
        },
        setTranscriptPath: async (transcriptPath: string) => {
            await scanner.setTranscriptPath(transcriptPath);
        }
    };
}

/**
 * Reverse-scan a bounded tail of a Codex transcript for the newest parent
 * token_count / rate-limit samples. Stops once both dimensions are found or
 * the byte budget is exhausted - does not allocate the full file.
 */
export async function readLatestCodexUsageFromTail(
    transcriptPath: string,
    options: ReadLatestCodexUsageFromTailOptions = {}
): Promise<unknown[]> {
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_USAGE_TAIL_MAX_BYTES);
    const readChunkBytes = Math.min(
        Math.max(1, options.chunkBytes ?? DEFAULT_USAGE_TAIL_READ_CHUNK_BYTES),
        maxBytes
    );
    const threadId = options.threadId;
    const accumulator = createReplayUsageAccumulator();
    let fd: number | undefined;
    try {
        const size = statSync(transcriptPath).size;
        if (size <= 0) return [];

        fd = openSync(transcriptPath, 'r');
        let position = size;
        const scanStart = Math.max(0, size - maxBytes);
        let incompletePrefix = Buffer.alloc(0);

        while (position > scanStart && !replayUsageComplete(accumulator)) {
            const length = Math.min(position - scanStart, readChunkBytes);
            position -= length;
            const buffer = Buffer.alloc(length);
            const bytesRead = readSync(fd, buffer, 0, length, position);
            const combined = Buffer.concat([buffer.subarray(0, bytesRead), incompletePrefix]);

            let complete = combined;
            if (position > scanStart) {
                const firstNewline = combined.indexOf(0x0a);
                if (firstNewline < 0) {
                    incompletePrefix = combined;
                    continue;
                }
                incompletePrefix = combined.subarray(0, firstNewline);
                complete = combined.subarray(firstNewline + 1);
            } else {
                incompletePrefix = Buffer.alloc(0);
            }

            const lines = complete.toString('utf8').split(/\r?\n/);
            // Newest lines are at the end of this chunk window.
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                noteUsageFromTranscriptLine(lines[index] ?? '', accumulator, threadId);
                if (replayUsageComplete(accumulator)) break;
            }
        }

        if (
            scanStart === 0
            && incompletePrefix.length > 0
            && !replayUsageComplete(accumulator)
        ) {
            noteUsageFromTranscriptLine(incompletePrefix.toString('utf8'), accumulator, threadId);
        }

        return orderedReplayUsagePayloads(accumulator);
    } catch (error) {
        logger.debug(`[codex-session-scanner] Failed to reverse-scan usage from ${transcriptPath}: ${error}`);
        return [];
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd); } catch { /* ignore */ }
        }
    }
}

function replayUsageComplete(accumulator: ReplayUsageAccumulator): boolean {
    return accumulator.latestTokens !== null && accumulator.latestRateLimits !== null;
}

function noteUsageFromTranscriptLine(
    line: string,
    accumulator: ReplayUsageAccumulator,
    threadId: string | undefined
): void {
    if (!line || line.trim().length === 0) return;
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return;
    }
    const event = parseCodexSessionEvent(parsed);
    if (!event) return;
    const converted = convertCodexEvent(event);
    for (const message of converted?.messages ?? []) {
        if (message.type !== 'token_count') continue;
        const scopeRole = message.scopeRole ?? message.scope_role;
        if (scopeRole === 'child') continue;
        const eventThreadId = message.threadId ?? message.thread_id;
        if (threadId && eventThreadId && eventThreadId !== threadId) continue;

        // Reverse scan: first hit per dimension is the newest.
        noteReplayUsageSampleIfAbsent(accumulator, message);
    }
}

class CodexSessionScannerImpl extends BaseSessionScanner<CodexSessionEvent> {
    private transcriptPath: string | null;
    private readonly onEvent: (event: CodexSessionEvent, context: { replayedHistory: boolean }) => void;
    private readonly onSessionId?: (sessionId: string) => void;
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly fileStateByPath = new Map<string, {
        device: number;
        inode: number;
        partialLine: Buffer;
        nextLineIndex: number;
    }>();
    private replayExistingHistoryOnNextAttach: boolean;
    private replayingExistingHistory = false;
    private readonly initialCursor: number | null;
    private observedSessionId: string | null = null;

    constructor(opts: CodexSessionScannerOptions) {
        super({ intervalMs: 2000 });
        this.transcriptPath = opts.transcriptPath;
        this.onEvent = opts.onEvent;
        this.onSessionId = opts.onSessionId;
        this.replayExistingHistoryOnNextAttach = opts.replayExistingHistory ?? false;
        this.initialCursor = typeof opts.initialCursor === 'number' && Number.isFinite(opts.initialCursor)
            ? Math.max(0, opts.initialCursor)
            : null;
    }

    async setTranscriptPath(transcriptPath: string): Promise<void> {
        if (this.transcriptPath === transcriptPath) {
            return;
        }
        this.transcriptPath = transcriptPath;
        await this.prepareTranscript(transcriptPath);
        this.pruneWatchers(this.transcriptPath ? [this.transcriptPath] : []);
        this.invalidate();
    }

    protected async initialize(): Promise<void> {
        if (this.transcriptPath) {
            await this.prepareTranscript(this.transcriptPath);
        }
    }

    protected async findSessionFiles(): Promise<string[]> {
        if (!this.transcriptPath) {
            return [];
        }
        return [this.transcriptPath];
    }

    protected shouldWatchFile(filePath: string): boolean {
        return Boolean(this.transcriptPath && filePath === this.transcriptPath);
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        return this.readSessionFile(filePath, cursor);
    }

    protected generateEventKey(_event: CodexSessionEvent, context: { filePath: string; lineIndex?: number }): string {
        const epoch = this.fileEpochByPath.get(context.filePath) ?? 0;
        return `${context.filePath}:${epoch}:${context.lineIndex ?? -1}`;
    }

    protected async handleFileScan(stats: SessionFileScanStats<CodexSessionEvent>): Promise<void> {
        const replayedHistory = this.replayingExistingHistory;
        try {
            for (const event of stats.events) {
                this.onEvent(event, { replayedHistory });
            }
        } finally {
            this.replayingExistingHistory = false;
        }
        if (stats.newCount > 0) {
            logger.debug(`[codex-session-scanner] ${stats.newCount} new events from ${stats.filePath}`);
        }
        this.pruneWatchers(this.transcriptPath ? [this.transcriptPath] : []);
    }

    private async prepareTranscript(filePath: string): Promise<void> {
        if (this.replayExistingHistoryOnNextAttach) {
            // 中文注释：导入既有 Codex thread 时，首次挂接 transcript 不能先 prime 到 EOF，
            // 否则 Hapi 只会看到后续增量，客户端里已经存在的最新消息会被跳过。
            this.replayExistingHistoryOnNextAttach = false;
            this.replayingExistingHistory = true;
            return;
        }

        this.replayingExistingHistory = false;
        if (this.initialCursor !== null) {
            await this.primeTranscriptAtOffset(filePath, this.initialCursor);
            return;
        }

        await this.primeTranscript(filePath);
    }

    private async primeTranscriptAtOffset(filePath: string, offset: number): Promise<void> {
        let fileStats;
        try {
            fileStats = await stat(filePath);
        } catch (error) {
            logger.debug(`[codex-session-scanner] Failed to stat transcript ${filePath}: ${error}`);
            return;
        }
        const cursor = Math.min(offset, fileStats.size);
        this.setCursor(filePath, cursor);
        this.fileStateByPath.set(filePath, {
            device: fileStats.dev,
            inode: fileStats.ino,
            partialLine: Buffer.alloc(0),
            nextLineIndex: 0
        });
    }

    private async primeTranscript(filePath: string): Promise<void> {
        const { events, nextCursor } = await this.readSessionFile(filePath, 0);
        const keys = events.map((entry) => this.generateEventKey(entry.event, { filePath, lineIndex: entry.lineIndex }));
        this.seedProcessedKeys(keys);
        this.setCursor(filePath, nextCursor);
    }

    private async readSessionFile(filePath: string, startOffset: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        let fileStats;
        try {
            fileStats = await stat(filePath);
        } catch (error) {
            logger.debug(`[codex-session-scanner] Failed to stat transcript ${filePath}: ${error}`);
            return { events: [], nextCursor: startOffset };
        }

        const previousState = this.fileStateByPath.get(filePath);
        const identityChanged = Boolean(
            previousState
            && (previousState.device !== fileStats.dev || previousState.inode !== fileStats.ino)
        );
        let effectiveStartOffset = startOffset;
        let partialLine = previousState?.partialLine ?? Buffer.alloc(0);
        let nextLineIndex = previousState?.nextLineIndex ?? 0;

        if (identityChanged || fileStats.size < effectiveStartOffset) {
            effectiveStartOffset = 0;
            partialLine = Buffer.alloc(0);
            nextLineIndex = 0;
            const nextEpoch = (this.fileEpochByPath.get(filePath) ?? 0) + 1;
            this.fileEpochByPath.set(filePath, nextEpoch);
        }

        const bytesToRead = fileStats.size - effectiveStartOffset;
        let appended: Buffer = Buffer.alloc(0);
        if (bytesToRead > 0) {
            try {
                appended = await readTranscriptRange(filePath, effectiveStartOffset, bytesToRead);
            } catch (error) {
                logger.debug(`[codex-session-scanner] Failed to read transcript ${filePath}: ${error}`);
                return { events: [], nextCursor: startOffset };
            }
        }

        const content = partialLine.length > 0
            ? Buffer.concat([partialLine, appended])
            : appended;
        const events: SessionFileScanEntry<CodexSessionEvent>[] = [];

        const parseLine = (lineBuffer: Buffer, lineIndex: number, allowIncomplete: boolean): boolean => {
            const line = lineBuffer.toString('utf-8');
            if (!line || line.trim().length === 0) return true;
            try {
                const event = parseCodexSessionEvent(JSON.parse(line));
                if (!event) return true;
                if (event.type === 'session_meta') {
                    const sessionId = extractSessionId(event);
                    if (sessionId) this.updateSessionId(sessionId);
                }
                events.push({ event, lineIndex });
                return true;
            } catch (error) {
                if (!allowIncomplete) {
                    logger.debug(`[codex-session-scanner] Failed to parse transcript line ${filePath}:${lineIndex + 1}: ${error}`);
                }
                return false;
            }
        };

        let lineStart = 0;
        for (let index = 0; index < content.length; index += 1) {
            if (content[index] !== 0x0a) continue;
            parseLine(content.subarray(lineStart, index), nextLineIndex, false);
            nextLineIndex += 1;
            lineStart = index + 1;
        }

        const trailing = content.subarray(lineStart);
        if (trailing.length > 0 && parseLine(trailing, nextLineIndex, true)) {
            partialLine = Buffer.alloc(0);
            nextLineIndex += 1;
        } else {
            partialLine = Buffer.from(trailing);
        }

        this.fileStateByPath.set(filePath, {
            device: fileStats.dev,
            inode: fileStats.ino,
            partialLine,
            nextLineIndex
        });

        return {
            events,
            nextCursor: effectiveStartOffset + appended.length
        };
    }

    private updateSessionId(sessionId: string): void {
        if (this.observedSessionId === sessionId) {
            return;
        }
        this.observedSessionId = sessionId;
        this.onSessionId?.(sessionId);
    }
}

export async function readTranscriptRange(filePath: string, startOffset: number, length: number): Promise<Buffer> {
    const content = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    const handle = await open(filePath, 'r');
    try {
        while (bytesRead < length) {
            const result = await handle.read(content, bytesRead, length - bytesRead, startOffset + bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
    } finally {
        await handle.close();
    }
    return bytesRead === content.length ? content : content.subarray(0, bytesRead);
}

function parseCodexSessionEvent(value: unknown): CodexSessionEvent | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string' || record.type.length === 0) {
        return null;
    }
    return {
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        type: record.type,
        payload: record.payload,
        ...(typeof record.thread_id === 'string' && record.thread_id.length > 0
            ? { thread_id: record.thread_id }
            : {}),
        ...(typeof record.threadId === 'string' && record.threadId.length > 0
            ? { threadId: record.threadId }
            : {})
    };
}

function extractSessionId(event: CodexSessionEvent): string | null {
    if (!event.payload || typeof event.payload !== 'object') {
        return null;
    }
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null;
}
