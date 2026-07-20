import { open, stat } from 'node:fs/promises';
import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from '@/modules/common/session/BaseSessionScanner';
import { logger } from '@/ui/logger';
import type { CodexSessionEvent } from './codexEventConverter';

interface CodexSessionScannerOptions {
    transcriptPath: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionId?: (sessionId: string) => void;
    replayExistingHistory?: boolean;
}

export interface CodexSessionScanner {
    cleanup: () => Promise<void>;
    setTranscriptPath: (transcriptPath: string) => Promise<void>;
}

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const scanner = new CodexSessionScannerImpl(opts);
    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        setTranscriptPath: async (transcriptPath: string) => {
            await scanner.setTranscriptPath(transcriptPath);
        }
    };
}

class CodexSessionScannerImpl extends BaseSessionScanner<CodexSessionEvent> {
    private transcriptPath: string | null;
    private readonly onEvent: (event: CodexSessionEvent) => void;
    private readonly onSessionId?: (sessionId: string) => void;
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly fileStateByPath = new Map<string, {
        device: number;
        inode: number;
        partialLine: Buffer;
        nextLineIndex: number;
    }>();
    private replayExistingHistoryOnNextAttach: boolean;
    private observedSessionId: string | null = null;

    constructor(opts: CodexSessionScannerOptions) {
        super({ intervalMs: 2000 });
        this.transcriptPath = opts.transcriptPath;
        this.onEvent = opts.onEvent;
        this.onSessionId = opts.onSessionId;
        this.replayExistingHistoryOnNextAttach = opts.replayExistingHistory ?? false;
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
        for (const event of stats.events) {
            this.onEvent(event);
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
            return;
        }

        await this.primeTranscript(filePath);
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
        payload: record.payload
    };
}

function extractSessionId(event: CodexSessionEvent): string | null {
    if (!event.payload || typeof event.payload !== 'object') {
        return null;
    }
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null;
}
