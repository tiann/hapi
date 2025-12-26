import { InvalidateSync } from '@/utils/sync';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';
import { logger } from '@/ui/logger';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { CodexSessionEvent } from './codexEventConverter';

interface CodexSessionScannerOptions {
    sessionId: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionFound?: (sessionId: string) => void;
    cwd?: string;
    startupTimestampMs?: number;
    sessionStartWindowMs?: number;
}

interface CodexSessionScanner {
    cleanup: () => Promise<void>;
    onNewSession: (sessionId: string) => void;
}

type PendingEvents = {
    events: CodexSessionEvent[];
    fileSessionId: string | null;
};

type CandidateReason = 'within-window' | 'outside-window' | 'no-timestamp' | 'unknown-cwd';

type Candidate = {
    sessionId: string;
    filePath: string;
    score: number;
    reason: CandidateReason;
};

const DEFAULT_SESSION_START_WINDOW_MS = 2 * 60 * 1000;

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const codexHomeDir = process.env.CODEX_HOME || join(homedir(), '.codex');
    const sessionsRoot = join(codexHomeDir, 'sessions');

    const processedLineCounts = new Map<string, number>();
    const watchers = new Map<string, () => void>();
    const sessionIdByFile = new Map<string, string>();
    const sessionCwdByFile = new Map<string, string>();
    const sessionTimestampByFile = new Map<string, number>();
    const pendingEventsByFile = new Map<string, PendingEvents>();
    const sessionMetaParsed = new Set<string>();

    let activeSessionId: string | null = opts.sessionId;
    let reportedSessionId: string | null = opts.sessionId;
    let isClosing = false;

    const targetCwd = opts.cwd ? normalizePath(opts.cwd) : null;
    const referenceTimestampMs = opts.startupTimestampMs ?? Date.now();
    const sessionStartWindowMs = opts.sessionStartWindowMs ?? DEFAULT_SESSION_START_WINDOW_MS;
    logger.debug(`[CODEX_SESSION_SCANNER] Init: targetCwd=${targetCwd ?? 'none'} startupTs=${new Date(referenceTimestampMs).toISOString()} windowMs=${sessionStartWindowMs}`);

    function reportSessionId(sessionId: string): void {
        if (reportedSessionId === sessionId) {
            return;
        }
        reportedSessionId = sessionId;
        opts.onSessionFound?.(sessionId);
    }

    function setActiveSessionId(sessionId: string): void {
        activeSessionId = sessionId;
        reportSessionId(sessionId);
        if (targetCwd) {
            flushPendingEventsForSession(sessionId);
        } else {
            pendingEventsByFile.clear();
        }
    }

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

        const hasSessionMeta = sessionMetaParsed.has(filePath);
        const parseFrom = hasSessionMeta ? effectiveStartLine : 0;

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
                    const sessionCwd = payload ? asString(payload.cwd) : null;
                    const normalizedCwd = sessionCwd ? normalizePath(sessionCwd) : null;
                    if (normalizedCwd) {
                        sessionCwdByFile.set(filePath, normalizedCwd);
                    }
                    const rawTimestamp = payload ? payload.timestamp : null;
                    const sessionTimestamp = payload ? parseTimestamp(payload.timestamp) : null;
                    if (sessionTimestamp !== null) {
                        sessionTimestampByFile.set(filePath, sessionTimestamp);
                    }
                    logger.debug(`[CODEX_SESSION_SCANNER] Session meta: file=${filePath} cwd=${sessionCwd ?? 'none'} normalizedCwd=${normalizedCwd ?? 'none'} timestamp=${rawTimestamp ?? 'none'} parsedTs=${sessionTimestamp ?? 'none'}`);
                    sessionMetaParsed.add(filePath);
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

    function getCandidateForFile(filePath: string): Candidate | null {
        const sessionId = sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = sessionCwdByFile.get(filePath);
        if (targetCwd && fileCwd && fileCwd !== targetCwd) {
            return null;
        }

        if (targetCwd && !fileCwd) {
            return {
                sessionId,
                filePath,
                score: Number.POSITIVE_INFINITY,
                reason: 'unknown-cwd'
            };
        }

        const sessionTimestamp = sessionTimestampByFile.get(filePath);
        if (sessionTimestamp === undefined) {
            return {
                sessionId,
                filePath,
                score: Number.POSITIVE_INFINITY,
                reason: 'no-timestamp'
            };
        }

        const diff = Math.abs(sessionTimestamp - referenceTimestampMs);
        if (diff > sessionStartWindowMs) {
            return {
                sessionId,
                filePath,
                score: diff,
                reason: 'outside-window'
            };
        }

        return {
            sessionId,
            filePath,
            score: diff,
            reason: 'within-window'
        };
    }

    function appendPendingEvents(filePath: string, events: CodexSessionEvent[], fileSessionId: string | null): void {
        if (events.length === 0) {
            return;
        }
        const existing = pendingEventsByFile.get(filePath);
        if (existing) {
            existing.events.push(...events);
            if (!existing.fileSessionId && fileSessionId) {
                existing.fileSessionId = fileSessionId;
            }
            return;
        }
        pendingEventsByFile.set(filePath, {
            events: [...events],
            fileSessionId
        });
    }

    function emitEvents(events: CodexSessionEvent[], fileSessionId: string | null): number {
        let emittedForFile = 0;
        for (const event of events) {
            const payload = asRecord(event.payload);
            const payloadSessionId = payload ? asString(payload.id) : null;
            const eventSessionId = payloadSessionId ?? fileSessionId ?? null;

            if (!activeSessionId && !targetCwd && eventSessionId) {
                setActiveSessionId(eventSessionId);
            }

            if (activeSessionId && eventSessionId && eventSessionId !== activeSessionId) {
                continue;
            }

            opts.onEvent(event);
            emittedForFile += 1;
        }
        return emittedForFile;
    }

    function flushPendingEventsForSession(sessionId: string): void {
        if (pendingEventsByFile.size === 0) {
            return;
        }
        let emitted = 0;
        for (const [filePath, pending] of pendingEventsByFile.entries()) {
            const matches = (pending.fileSessionId && pending.fileSessionId === sessionId)
                || filePath.endsWith(`-${sessionId}.jsonl`);
            if (!matches) {
                continue;
            }
            emitted += emitEvents(pending.events, pending.fileSessionId);
        }
        pendingEventsByFile.clear();
        if (emitted > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emitted} pending events for session ${sessionId}`);
        }
    }

    const sync = new InvalidateSync(async () => {
        if (isClosing) {
            return;
        }
        const files = await listSessionFiles(sessionsRoot);
        const sortedFiles = await sortFilesByMtime(files);
        let bestWithinWindow: Candidate | null = null;
        let bestOutsideWindow: Candidate | null = null;
        let bestNoTimestamp: Candidate | null = null;
        let bestUnknownCwd: Candidate | null = null;

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
            const candidate = !activeSessionId && targetCwd ? getCandidateForFile(filePath) : null;
            if (!activeSessionId && targetCwd) {
                appendPendingEvents(filePath, events, fileSessionId ?? candidate?.sessionId ?? null);
                if (candidate) {
                    switch (candidate.reason) {
                        case 'within-window':
                            if (!bestWithinWindow || candidate.score < bestWithinWindow.score) {
                                bestWithinWindow = candidate;
                            }
                            break;
                        case 'outside-window':
                            if (!bestOutsideWindow || candidate.score < bestOutsideWindow.score) {
                                bestOutsideWindow = candidate;
                            }
                            break;
                        case 'no-timestamp':
                            if (!bestNoTimestamp) {
                                bestNoTimestamp = candidate;
                            }
                            break;
                        case 'unknown-cwd':
                            if (!bestUnknownCwd) {
                                bestUnknownCwd = candidate;
                            }
                            break;
                    }
                }
                continue;
            }

            const emittedForFile = emitEvents(events, fileSessionId ?? null);
            if (emittedForFile > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
            }
        }

        if (!activeSessionId && targetCwd) {
            const selectedCandidate = bestWithinWindow
                ?? bestOutsideWindow
                ?? bestNoTimestamp
                ?? bestUnknownCwd
                ?? null;
            if (selectedCandidate) {
                if (selectedCandidate.reason === 'within-window') {
                    logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${selectedCandidate.sessionId} within start window`);
                } else {
                    logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${selectedCandidate.sessionId} via fallback (${selectedCandidate.reason})`);
                }
                setActiveSessionId(selectedCandidate.sessionId);
            } else if (pendingEventsByFile.size > 0) {
                logger.debug('[CODEX_SESSION_SCANNER] No session candidate matched yet; pending events buffered');
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

function parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

function normalizePath(value: string): string {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
