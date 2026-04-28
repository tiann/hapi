import { readFile } from 'node:fs/promises';
import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from '@/modules/common/session/BaseSessionScanner';
import { logger } from '@/ui/logger';
import type { CodexSessionEvent } from './codexEventConverter';

interface CodexSessionScannerOptions {
    transcriptPath: string | null;
    replayExistingEvents?: boolean;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionId?: (sessionId: string) => void;
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
    private readonly replayExistingEvents: boolean;
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly fileSizeByPath = new Map<string, number>();
    private observedSessionId: string | null = null;

    constructor(opts: CodexSessionScannerOptions) {
        super({ intervalMs: 2000 });
        this.transcriptPath = opts.transcriptPath;
        this.onEvent = opts.onEvent;
        this.onSessionId = opts.onSessionId;
        this.replayExistingEvents = opts.replayExistingEvents === true;
    }

    async setTranscriptPath(transcriptPath: string): Promise<void> {
        if (this.transcriptPath === transcriptPath) {
            return;
        }
        this.transcriptPath = transcriptPath;
        await this.primeTranscript(transcriptPath);
        this.pruneWatchers(this.transcriptPath ? [this.transcriptPath] : []);
        this.invalidate();
    }

    protected async initialize(): Promise<void> {
        if (this.transcriptPath) {
            await this.primeTranscript(this.transcriptPath);
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

    private async primeTranscript(filePath: string): Promise<void> {
        const { events, nextCursor } = await this.readSessionFile(filePath, 0);
        if (this.replayExistingEvents) {
            for (const entry of events) {
                this.onEvent(entry.event);
            }
        }
        const keys = events.map((entry) => this.generateEventKey(entry.event, { filePath, lineIndex: entry.lineIndex }));
        this.seedProcessedKeys(keys);
        this.setCursor(filePath, nextCursor);
    }

    private async readSessionFile(filePath: string, startLine: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch (error) {
            logger.debug(`[codex-session-scanner] Failed to read transcript ${filePath}: ${error}`);
            return { events: [], nextCursor: startLine };
        }

        const lines = content.split('\n');
        const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
        const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
        const currentSize = Buffer.byteLength(content);
        const previousSize = this.fileSizeByPath.get(filePath);
        let effectiveStartLine = startLine;

        if ((previousSize !== undefined && currentSize < previousSize) || effectiveStartLine > totalLines) {
            effectiveStartLine = 0;
            const nextEpoch = (this.fileEpochByPath.get(filePath) ?? 0) + 1;
            this.fileEpochByPath.set(filePath, nextEpoch);
        }
        this.fileSizeByPath.set(filePath, currentSize);

        const events: SessionFileScanEntry<CodexSessionEvent>[] = [];
        for (let lineIndex = 0; lineIndex < totalLines; lineIndex += 1) {
            const line = lines[lineIndex];
            if (!line || line.trim().length === 0) {
                continue;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch (error) {
                logger.debug(`[codex-session-scanner] Failed to parse transcript line ${filePath}:${lineIndex + 1}: ${error}`);
                continue;
            }

            const event = parseCodexSessionEvent(parsed);
            if (!event) {
                continue;
            }

            if (event.type === 'session_meta') {
                const sessionId = extractSessionId(event);
                if (sessionId) {
                    this.updateSessionId(sessionId);
                }
            }

            if (lineIndex < effectiveStartLine) {
                continue;
            }

            events.push({ event, lineIndex });
        }

        return {
            events,
            nextCursor: totalLines
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
