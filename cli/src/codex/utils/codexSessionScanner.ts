import { InvalidateSync } from '@/utils/sync';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';
import { logger } from '@/ui/logger';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { CodexSessionEvent } from './codexEventConverter';

interface CodexSessionScannerOptions {
    sessionId: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionFound?: (sessionId: string) => void;
}

interface CodexSessionScanner {
    cleanup: () => Promise<void>;
    onNewSession: (sessionId: string) => void;
}

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const codexHomeDir = process.env.CODEX_HOME || join(homedir(), '.codex');
    const sessionsRoot = join(codexHomeDir, 'sessions');

    const processedLineCounts = new Map<string, number>();
    const watchers = new Map<string, () => void>();
    const sessionIdByFile = new Map<string, string>();

    let activeSessionId: string | null = opts.sessionId;
    let reportedSessionId: string | null = opts.sessionId;
    let isClosing = false;

    const reportSessionId = (sessionId: string) => {
        if (reportedSessionId === sessionId) {
            return;
        }
        reportedSessionId = sessionId;
        opts.onSessionFound?.(sessionId);
    };

    const setActiveSessionId = (sessionId: string) => {
        activeSessionId = sessionId;
        reportSessionId(sessionId);
    };

    async function listSessionFiles(dir: string): Promise<string[]> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            const results: string[] = [];
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(...await listSessionFiles(full));
                } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    results.push(full);
                }
            }
            return results;
        } catch (error) {
            return [];
        }
    }

    async function readSessionFile(filePath: string, startLine: number): Promise<{ events: CodexSessionEvent[]; totalLines: number }> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch (error) {
            return { events: [], totalLines: startLine };
        }

        const events: CodexSessionEvent[] = [];
        const lines = content.split('\n');
        const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
        const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
        let effectiveStartLine = startLine;
        if (effectiveStartLine > totalLines) {
            effectiveStartLine = 0;
        }

        const hasSessionId = sessionIdByFile.has(filePath);
        const parseFrom = hasSessionId ? effectiveStartLine : 0;

        for (let index = parseFrom; index < lines.length; index += 1) {
            const trimmed = lines[index].trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed?.type === 'session_meta') {
                    const payload = asRecord(parsed.payload);
                    const sessionId = payload ? asString(payload.id) : null;
                    if (sessionId) {
                        sessionIdByFile.set(filePath, sessionId);
                    }
                }
                if (index >= effectiveStartLine) {
                    events.push(parsed);
                }
            } catch (error) {
                logger.debug(`[CODEX_SESSION_SCANNER] Failed to parse line: ${error}`);
            }
        }

        return { events, totalLines };
    }

    async function initializeProcessedMessages(): Promise<void> {
        const files = await listSessionFiles(sessionsRoot);
        for (const filePath of files) {
            const { totalLines } = await readSessionFile(filePath, 0);
            processedLineCounts.set(filePath, totalLines);
            if (!isClosing && !watchers.has(filePath)) {
                watchers.set(filePath, startFileWatcher(filePath, () => sync.invalidate()));
            }
        }
    }

    const sync = new InvalidateSync(async () => {
        if (isClosing) {
            return;
        }
        const files = await listSessionFiles(sessionsRoot);
        const sortedFiles = await sortFilesByMtime(files);

        for (const filePath of sortedFiles) {
            if (isClosing) {
                return;
            }
            if (!watchers.has(filePath)) {
                watchers.set(filePath, startFileWatcher(filePath, () => sync.invalidate()));
            }

            const fileSessionId = sessionIdByFile.get(filePath);
            if (activeSessionId && fileSessionId && fileSessionId !== activeSessionId) {
                continue;
            }
            if (activeSessionId && !fileSessionId && !filePath.endsWith(`-${activeSessionId}.jsonl`)) {
                continue;
            }

            const lastProcessedLine = processedLineCounts.get(filePath) ?? 0;
            const { events, totalLines } = await readSessionFile(filePath, lastProcessedLine);
            processedLineCounts.set(filePath, totalLines);
            let emittedForFile = 0;

            for (const event of events) {
                const payload = asRecord(event.payload);
                const payloadSessionId = payload ? asString(payload.id) : null;
                const eventSessionId = payloadSessionId ?? fileSessionId ?? null;

                if (!activeSessionId && eventSessionId) {
                    setActiveSessionId(eventSessionId);
                }

                if (activeSessionId && eventSessionId && eventSessionId !== activeSessionId) {
                    continue;
                }

                opts.onEvent(event);
                emittedForFile += 1;
            }

            if (emittedForFile > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
            }
        }
    });

    await initializeProcessedMessages();
    await sync.invalidateAndAwait();
    const intervalId = setInterval(() => sync.invalidate(), 2000);

    return {
        cleanup: async () => {
            isClosing = true;
            clearInterval(intervalId);
            sync.stop();
            for (const stop of watchers.values()) {
                stop();
            }
            watchers.clear();
        },
        onNewSession: (sessionId: string) => {
            if (activeSessionId === sessionId) {
                return;
            }
            logger.debug(`[CODEX_SESSION_SCANNER] Switching to new session: ${sessionId}`);
            setActiveSessionId(sessionId);
            sync.invalidate();
        }
    };
}

async function sortFilesByMtime(files: string[]): Promise<string[]> {
    const entries = await Promise.all(files.map(async (file) => {
        try {
            const stats = await stat(file);
            return { file, mtimeMs: stats.mtimeMs };
        } catch {
            return { file, mtimeMs: 0 };
        }
    }));

    return entries
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((entry) => entry.file);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
