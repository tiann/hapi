import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";
import { logger } from "@/ui/logger";
import { join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir, stat, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { CodexSessionEvent } from "./codexEventConverter";

interface CodexSessionScannerOptions {
    sessionId: string | null;
    resumeFromSessionId?: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionFound?: (sessionId: string) => void;
    onSessionMatchFailed?: (message: string) => void;
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

type Candidate = {
    sessionId: string;
    score: number;
};

const DEFAULT_SESSION_START_WINDOW_MS = 2 * 60 * 1000;

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const targetCwd = opts.cwd && opts.cwd.trim().length > 0 ? normalizePath(opts.cwd) : null;

    // Load history from previous session if resuming
    if (opts.resumeFromSessionId) {
        await loadPreviousSessionHistory(opts.resumeFromSessionId, targetCwd, opts.onEvent);
    }

    if (!targetCwd && !opts.sessionId) {
        const message = 'No cwd provided for Codex session matching; refusing to fallback.';
        logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
        opts.onSessionMatchFailed?.(message);
        return {
            cleanup: async () => {},
            onNewSession: () => {}
        };
    }

    const scanner = new CodexSessionScannerImpl(opts, targetCwd);
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

class CodexSessionScannerImpl extends BaseSessionScanner<CodexSessionEvent> {
    private readonly sessionsRoot: string;
    private readonly onEvent: (event: CodexSessionEvent) => void;
    private readonly onSessionFound?: (sessionId: string) => void;
    private readonly onSessionMatchFailed?: (message: string) => void;
    private readonly sessionIdByFile = new Map<string, string>();
    private readonly sessionCwdByFile = new Map<string, string>();
    private readonly sessionTimestampByFile = new Map<string, number>();
    private readonly pendingEventsByFile = new Map<string, PendingEvents>();
    private readonly sessionMetaParsed = new Set<string>();
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly targetCwd: string | null;
    private readonly referenceTimestampMs: number;
    private readonly sessionStartWindowMs: number;
    private readonly matchDeadlineMs: number;
    private readonly sessionDatePrefixes: Set<string> | null;

    private activeSessionId: string | null;
    private reportedSessionId: string | null;
    private matchFailed = false;
    private bestWithinWindow: Candidate | null = null;

    constructor(opts: CodexSessionScannerOptions, targetCwd: string | null) {
        super({ intervalMs: 2000 });
        const codexHomeDir = process.env.CODEX_HOME || join(homedir(), '.codex');
        this.sessionsRoot = join(codexHomeDir, 'sessions');
        this.onEvent = opts.onEvent;
        this.onSessionFound = opts.onSessionFound;
        this.onSessionMatchFailed = opts.onSessionMatchFailed;
        this.activeSessionId = opts.sessionId;
        this.reportedSessionId = opts.sessionId;
        this.targetCwd = targetCwd;
        this.referenceTimestampMs = opts.startupTimestampMs ?? Date.now();
        this.sessionStartWindowMs = opts.sessionStartWindowMs ?? DEFAULT_SESSION_START_WINDOW_MS;
        this.matchDeadlineMs = this.referenceTimestampMs + this.sessionStartWindowMs;
        this.sessionDatePrefixes = this.targetCwd
            ? getSessionDatePrefixes(this.referenceTimestampMs, this.sessionStartWindowMs)
            : null;

        logger.debug(`[CODEX_SESSION_SCANNER] Init: targetCwd=${this.targetCwd ?? 'none'} startupTs=${new Date(this.referenceTimestampMs).toISOString()} windowMs=${this.sessionStartWindowMs}`);
    }

    public onNewSession(sessionId: string): void {
        if (this.activeSessionId === sessionId) {
            return;
        }
        logger.debug(`[CODEX_SESSION_SCANNER] Switching to new session: ${sessionId}`);
        this.setActiveSessionId(sessionId);
        this.invalidate();
    }

    protected shouldScan(): boolean {
        return !this.matchFailed;
    }

    protected shouldWatchFile(filePath: string): boolean {
        if (!this.activeSessionId) {
            if (!this.targetCwd) {
                return false;
            }
            return this.getCandidateForFile(filePath) !== null;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId) {
            return fileSessionId === this.activeSessionId;
        }
        return filePath.endsWith(`-${this.activeSessionId}.jsonl`);
    }

    protected async initialize(): Promise<void> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        for (const filePath of files) {
            const { nextCursor } = await this.readSessionFile(filePath, 0);
            this.setCursor(filePath, nextCursor);
            if (this.shouldWatchFile(filePath)) {
                this.ensureWatcher(filePath);
            }
        }
    }

    protected async beforeScan(): Promise<void> {
        this.bestWithinWindow = null;
    }

    protected async findSessionFiles(): Promise<string[]> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        return sortFilesByMtime(files);
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        if (this.shouldSkipFile(filePath)) {
            return { events: [], nextCursor: cursor };
        }
        return this.readSessionFile(filePath, cursor);
    }

    protected generateEventKey(event: CodexSessionEvent, context: { filePath: string; lineIndex?: number }): string {
        const epoch = this.fileEpochByPath.get(context.filePath) ?? 0;
        const lineIndex = context.lineIndex ?? -1;
        return `${context.filePath}:${epoch}:${lineIndex}`;
    }

    protected async handleFileScan(stats: SessionFileScanStats<CodexSessionEvent>): Promise<void> {
        const filePath = stats.filePath;
        const fileSessionId = this.sessionIdByFile.get(filePath) ?? null;

        if (!this.activeSessionId && this.targetCwd) {
            this.appendPendingEvents(filePath, stats.events, fileSessionId);
            const candidate = this.getCandidateForFile(filePath);
            if (candidate) {
                if (!this.bestWithinWindow || candidate.score < this.bestWithinWindow.score) {
                    this.bestWithinWindow = candidate;
                }
            }
            if (stats.newCount > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Buffered ${stats.newCount} pending events from ${filePath}`);
            }
            return;
        }

        const emittedForFile = this.emitEvents(stats.events, fileSessionId);
        if (emittedForFile > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
        }
    }

    protected async afterScan(): Promise<void> {
        if (!this.activeSessionId && this.targetCwd) {
            if (this.bestWithinWindow) {
                logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${this.bestWithinWindow.sessionId} within start window`);
                this.setActiveSessionId(this.bestWithinWindow.sessionId);
            } else if (Date.now() > this.matchDeadlineMs) {
                this.matchFailed = true;
                this.pendingEventsByFile.clear();
                const message = `No Codex session found within ${this.sessionStartWindowMs}ms for cwd ${this.targetCwd}; refusing fallback.`;
                logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
                this.onSessionMatchFailed?.(message);
            } else if (this.pendingEventsByFile.size > 0) {
                logger.debug('[CODEX_SESSION_SCANNER] No session candidate matched yet; pending events buffered');
            }
        }
    }

    private shouldSkipFile(filePath: string): boolean {
        if (!this.activeSessionId) {
            return false;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId && fileSessionId !== this.activeSessionId) {
            return true;
        }
        if (!fileSessionId && !filePath.endsWith(`-${this.activeSessionId}.jsonl`)) {
            return true;
        }
        return false;
    }

    private reportSessionId(sessionId: string): void {
        if (this.reportedSessionId === sessionId) {
            return;
        }
        this.reportedSessionId = sessionId;
        this.onSessionFound?.(sessionId);
    }

    private setActiveSessionId(sessionId: string): void {
        this.activeSessionId = sessionId;
        this.reportSessionId(sessionId);
        const candidateFiles = this.getFilesForSession(sessionId);
        for (const filePath of candidateFiles) {
            if (this.shouldWatchFile(filePath)) {
                this.ensureWatcher(filePath);
            }
        }
        this.pruneWatchers(this.getWatchedFiles().filter((filePath) => this.shouldWatchFile(filePath)));
        if (this.targetCwd) {
            this.flushPendingEventsForSession(sessionId);
        } else {
            this.pendingEventsByFile.clear();
        }
    }

    private async listSessionFiles(dir: string): Promise<string[]> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            const results: string[] = [];
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (!shouldIncludeSessionPath(full, this.sessionsRoot, this.sessionDatePrefixes)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    results.push(...await this.listSessionFiles(full));
                } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    results.push(full);
                }
            }
            return results;
        } catch (error) {
            return [];
        }
    }

    private async readSessionFile(filePath: string, startLine: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch (error) {
            return { events: [], nextCursor: startLine };
        }

        const events: SessionFileScanEntry<CodexSessionEvent>[] = [];
        const lines = content.split('\n');
        const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
        const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
        let effectiveStartLine = startLine;
        if (effectiveStartLine > totalLines) {
            effectiveStartLine = 0;
            const nextEpoch = (this.fileEpochByPath.get(filePath) ?? 0) + 1;
            this.fileEpochByPath.set(filePath, nextEpoch);
        }

        const hasSessionMeta = this.sessionMetaParsed.has(filePath);
        const parseFrom = hasSessionMeta ? effectiveStartLine : 0;

        for (let index = parseFrom; index < lines.length; index += 1) {
            const trimmed = lines[index].trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed) as CodexSessionEvent;
                if (parsed?.type === 'session_meta') {
                    const payload = asRecord(parsed.payload);
                    const sessionId = payload ? asString(payload.id) : null;
                    if (sessionId) {
                        this.sessionIdByFile.set(filePath, sessionId);
                    }
                    const sessionCwd = payload ? asString(payload.cwd) : null;
                    const normalizedCwd = sessionCwd ? normalizePath(sessionCwd) : null;
                    if (normalizedCwd) {
                        this.sessionCwdByFile.set(filePath, normalizedCwd);
                    }
                    const rawTimestamp = payload ? payload.timestamp : null;
                    const sessionTimestamp = payload ? parseTimestamp(payload.timestamp) : null;
                    if (sessionTimestamp !== null) {
                        this.sessionTimestampByFile.set(filePath, sessionTimestamp);
                    }
                    logger.debug(`[CODEX_SESSION_SCANNER] Session meta: file=${filePath} cwd=${sessionCwd ?? 'none'} normalizedCwd=${normalizedCwd ?? 'none'} timestamp=${rawTimestamp ?? 'none'} parsedTs=${sessionTimestamp ?? 'none'}`);
                    this.sessionMetaParsed.add(filePath);
                }
                if (index >= effectiveStartLine) {
                    events.push({ event: parsed, lineIndex: index });
                }
            } catch (error) {
                logger.debug(`[CODEX_SESSION_SCANNER] Failed to parse line: ${error}`);
            }
        }

        return { events, nextCursor: totalLines };
    }

    private getCandidateForFile(filePath: string): Candidate | null {
        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return null;
        }

        const sessionTimestamp = this.sessionTimestampByFile.get(filePath);
        if (sessionTimestamp === undefined) {
            return null;
        }

        if (sessionTimestamp < this.referenceTimestampMs) {
            return null;
        }

        const diff = sessionTimestamp - this.referenceTimestampMs;
        if (diff > this.sessionStartWindowMs) {
            return null;
        }

        return {
            sessionId,
            score: diff
        };
    }

    private getFilesForSession(sessionId: string): string[] {
        const matches: string[] = [];
        for (const [filePath, storedSessionId] of this.sessionIdByFile.entries()) {
            if (storedSessionId === sessionId) {
                matches.push(filePath);
            }
        }
        if (matches.length > 0) {
            return matches;
        }
        const suffix = `-${sessionId}.jsonl`;
        return this.getWatchedFiles().filter((filePath) => filePath.endsWith(suffix));
    }

    private appendPendingEvents(filePath: string, events: CodexSessionEvent[], fileSessionId: string | null): void {
        if (events.length === 0) {
            return;
        }
        const existing = this.pendingEventsByFile.get(filePath);
        if (existing) {
            existing.events.push(...events);
            if (!existing.fileSessionId && fileSessionId) {
                existing.fileSessionId = fileSessionId;
            }
            return;
        }
        this.pendingEventsByFile.set(filePath, {
            events: [...events],
            fileSessionId
        });
    }

    private emitEvents(events: CodexSessionEvent[], fileSessionId: string | null): number {
        let emittedForFile = 0;
        for (const event of events) {
            const payload = asRecord(event.payload);
            const payloadSessionId = payload ? asString(payload.id) : null;
            const eventSessionId = payloadSessionId ?? fileSessionId ?? null;

            if (this.activeSessionId && eventSessionId && eventSessionId !== this.activeSessionId) {
                continue;
            }

            this.onEvent(event);
            emittedForFile += 1;
        }
        return emittedForFile;
    }

    private flushPendingEventsForSession(sessionId: string): void {
        if (this.pendingEventsByFile.size === 0) {
            return;
        }
        let emitted = 0;
        for (const [filePath, pending] of this.pendingEventsByFile.entries()) {
            const matches = (pending.fileSessionId && pending.fileSessionId === sessionId)
                || filePath.endsWith(`-${sessionId}.jsonl`);
            if (!matches) {
                continue;
            }
            emitted += this.emitEvents(pending.events, pending.fileSessionId);
        }
        this.pendingEventsByFile.clear();
        if (emitted > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emitted} pending events for session ${sessionId}`);
        }
    }
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

function getSessionDatePrefixes(referenceTimestampMs: number, windowMs: number): Set<string> {
    const startDate = new Date(referenceTimestampMs - windowMs);
    const endDate = new Date(referenceTimestampMs + windowMs);
    const current = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const prefixes = new Set<string>();

    while (current <= last) {
        const year = String(current.getFullYear());
        const month = String(current.getMonth() + 1).padStart(2, '0');
        const day = String(current.getDate()).padStart(2, '0');
        prefixes.add(`${year}/${month}/${day}`);
        current.setDate(current.getDate() + 1);
    }

    return prefixes;
}

function shouldIncludeSessionPath(
    fullPath: string,
    sessionsRoot: string,
    prefixes: Set<string> | null
): boolean {
    if (!prefixes) {
        return true;
    }

    const relativePath = relative(sessionsRoot, fullPath);
    if (!relativePath || relativePath.startsWith('..')) {
        return true;
    }

    const normalized = relativePath.split(sep).filter(Boolean).join('/');
    if (!normalized) {
        return true;
    }

    for (const prefix of prefixes) {
        if (normalized === prefix) {
            return true;
        }
        if (normalized.startsWith(`${prefix}/`)) {
            return true;
        }
        if (prefix.startsWith(`${normalized}/`)) {
            return true;
        }
    }

    return false;
}

/**
 * Load and replay history from previous Codex session
 */
async function loadPreviousSessionHistory(
    sessionId: string,
    cwd: string | null,
    onEvent: (event: CodexSessionEvent) => void
): Promise<void> {
    try {
        const sessionFile = await findCodexSessionFile(sessionId, cwd);

        if (!sessionFile) {
            logger.warn(`[CODEX_SESSION_SCANNER] Previous session file not found: ${sessionId}`);
            return;
        }

        logger.info(`[CODEX_SESSION_SCANNER] Loading history from session: ${sessionId}`);
        const events = await readCodexSessionLog(sessionFile);

        // Replay events
        for (const event of events) {
            onEvent(event);
        }

        logger.info(`[CODEX_SESSION_SCANNER] Replayed ${events.length} events from previous session`);
    } catch (error) {
        logger.error('[CODEX_SESSION_SCANNER] Failed to load previous session history:', error);
        // Continue - partial history better than crash
    }
}

/**
 * Find Codex session JSONL file
 */
async function findCodexSessionFile(
    sessionId: string,
    cwd: string | null
): Promise<string | null> {
    try {
        const codexHomeDir = process.env.CODEX_HOME || join(homedir(), '.codex');
        const sessionsDir = join(codexHomeDir, 'sessions');

        // Codex stores sessions at: ~/.codex/sessions/<cwd-hash>/<sessionId>.jsonl
        if (cwd) {
            // Generate hash of working directory (Codex convention)
            const cwdHash = createHash('sha256').update(normalizePath(cwd)).digest('hex').slice(0, 16);
            const sessionFile = join(sessionsDir, cwdHash, `${sessionId}.jsonl`);

            try {
                await access(sessionFile);
                return sessionFile;
            } catch {
                // Fall through to search all directories
            }
        }

        // If hash approach failed or no cwd, search all session directories
        const entries = await readdir(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const sessionFile = join(sessionsDir, entry.name, `${sessionId}.jsonl`);
                try {
                    await access(sessionFile);
                    return sessionFile;
                } catch {
                    // Continue searching
                }
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Read and parse Codex session log file
 */
async function readCodexSessionLog(filePath: string): Promise<CodexSessionEvent[]> {
    const events: CodexSessionEvent[] = [];
    const MAX_EVENTS = 40;
    const MAX_CHARS = 16000;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    let totalChars = 0;

    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const event = JSON.parse(line) as CodexSessionEvent;

            // Apply limits
            if (events.length >= MAX_EVENTS) {
                logger.warn(`[CODEX_SESSION_SCANNER] Reached max events (${MAX_EVENTS}), truncating history`);
                break;
            }

            const eventSize = JSON.stringify(event).length;
            if (totalChars + eventSize > MAX_CHARS) {
                logger.warn(`[CODEX_SESSION_SCANNER] Reached max size (${MAX_CHARS} chars), truncating history`);
                break;
            }

            events.push(event);
            totalChars += eventSize;
        } catch (parseError) {
            logger.warn('[CODEX_SESSION_SCANNER] Failed to parse event line, skipping:', parseError);
            // Continue - partial history better than none
        }
    }

    return events;
}
