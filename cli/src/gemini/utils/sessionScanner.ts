import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import {
    BaseSessionScanner,
    SessionFileScanEntry,
    SessionFileScanResult,
    SessionFileScanStats
} from '@/modules/common/session/BaseSessionScanner';

type GeminiTranscriptMessage = {
    id?: string;
    type?: string;
    content?: string;
    [key: string]: unknown;
};

type GeminiTranscript = {
    sessionId?: string;
    messages?: GeminiTranscriptMessage[];
    [key: string]: unknown;
};

export async function createGeminiSessionScanner(opts: {
    transcriptPath: string | null;
    onMessage: (message: GeminiTranscriptMessage) => void;
    onSessionId?: (sessionId: string) => void;
}) {
    const scanner = new GeminiSessionScanner({
        transcriptPath: opts.transcriptPath,
        onMessage: opts.onMessage,
        onSessionId: opts.onSessionId
    });

    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (transcriptPath: string) => {
            void scanner.setTranscriptPath(transcriptPath);
        }
    };
}

class GeminiSessionScanner extends BaseSessionScanner<GeminiTranscriptMessage> {
    private transcriptPath: string | null;
    private readonly onMessage: (message: GeminiTranscriptMessage) => void;
    private readonly onSessionId?: (sessionId: string) => void;
    private observedSessionId: string | null = null;

    constructor(opts: {
        transcriptPath: string | null;
        onMessage: (message: GeminiTranscriptMessage) => void;
        onSessionId?: (sessionId: string) => void;
    }) {
        super({ intervalMs: 2000 });
        this.transcriptPath = opts.transcriptPath;
        this.onMessage = opts.onMessage;
        this.onSessionId = opts.onSessionId;
    }

    async setTranscriptPath(path: string): Promise<void> {
        if (this.transcriptPath === path) {
            return;
        }
        this.transcriptPath = path;
        await this.primeTranscript(path);
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

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<GeminiTranscriptMessage>> {
        const transcript = await readTranscript(filePath);
        if (!transcript) {
            return { events: [], nextCursor: cursor };
        }

        this.updateSessionId(transcript.sessionId);

        const messages = transcript.messages ?? [];
        let startIndex = cursor;
        if (startIndex > messages.length) {
            startIndex = 0;
        }

        const events: SessionFileScanEntry<GeminiTranscriptMessage>[] = [];
        for (let index = startIndex; index < messages.length; index += 1) {
            events.push({ event: messages[index], lineIndex: index });
        }

        return {
            events,
            nextCursor: messages.length
        };
    }

    protected generateEventKey(event: GeminiTranscriptMessage, context: { filePath: string; lineIndex?: number }): string {
        if (event.id && event.id.length > 0) {
            return `${context.filePath}:${event.id}`;
        }
        return `${context.filePath}:${context.lineIndex ?? -1}`;
    }

    protected async handleFileScan(stats: SessionFileScanStats<GeminiTranscriptMessage>): Promise<void> {
        for (const message of stats.events) {
            this.onMessage(message);
        }
        if (stats.newCount > 0) {
            logger.debug(`[gemini-session-scanner] ${stats.newCount} new messages from ${stats.filePath}`);
        }
        this.pruneWatchers(this.transcriptPath ? [this.transcriptPath] : []);
    }

    private updateSessionId(sessionId: string | undefined): void {
        if (!sessionId || sessionId.length === 0) {
            return;
        }
        if (this.observedSessionId === sessionId) {
            return;
        }
        this.observedSessionId = sessionId;
        this.onSessionId?.(sessionId);
    }

    private async primeTranscript(filePath: string): Promise<void> {
        const transcript = await readTranscript(filePath);
        if (!transcript) {
            return;
        }
        this.updateSessionId(transcript.sessionId);

        const messages = transcript.messages ?? [];
        const keys = messages.map((message, index) => this.generateEventKey(message, { filePath, lineIndex: index }));
        this.seedProcessedKeys(keys);
        this.setCursor(filePath, messages.length);
    }
}

/**
 * Finds the transcript file path for a given gemini session ID.
 * Gemini stores session files as ~/.gemini/tmp/<user>/chats/session-*<prefix>*.json
 * where <prefix> is the first 8 characters of the session UUID.
 */
export async function findGeminiTranscriptPath(sessionId: string): Promise<string | null> {
    const prefix = sessionId.slice(0, 8);
    const geminiTmpDir = join(homedir(), '.gemini', 'tmp');
    try {
        const userDirs = await readdir(geminiTmpDir);
        for (const userDir of userDirs) {
            const chatsDir = join(geminiTmpDir, userDir, 'chats');
            try {
                const files = await readdir(chatsDir);
                const match = files.find(f => f.includes(prefix) && f.endsWith('.json'));
                if (match) {
                    return join(chatsDir, match);
                }
            } catch {
                continue;
            }
        }
    } catch {
        // gemini tmp dir may not exist
    }
    return null;
}

export async function readGeminiTranscript(filePath: string): Promise<GeminiTranscript | null> {
    return readTranscript(filePath);
}

async function readTranscript(filePath: string): Promise<GeminiTranscript | null> {
    try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        const messages = Array.isArray(record.messages)
            ? record.messages.filter((value): value is GeminiTranscriptMessage => Boolean(value && typeof value === 'object'))
            : [];
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
        return {
            sessionId,
            messages
        };
    } catch (error) {
        logger.debug(`[gemini-session-scanner] Failed to read transcript ${filePath}: ${error}`);
        return null;
    }
}
