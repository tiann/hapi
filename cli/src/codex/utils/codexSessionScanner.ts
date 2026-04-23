import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";
import { logger } from "@/ui/logger";
import { join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import type { ResolveCodexSessionFileResult } from "./resolveCodexSessionFile";
import type { CodexSessionEvent } from "./codexEventConverter";

interface CodexSessionScannerOptions {
    sessionId: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionFound?: (sessionId: string) => void;
    onSessionMatchFailed?: (message: string) => void;
    resolvedSessionFile?: ResolveCodexSessionFileResult | null;
    cwd?: string;
    startupTimestampMs?: number;
    sessionStartWindowMs?: number;
}

interface CodexSessionScanner {
    cleanup: () => Promise<void>;
    onNewSession: (sessionId: string) => void;
}

type PendingEvents = {
    entries: SessionFileScanEntry<CodexSessionEvent>[];
    fileSessionId: string | null;
};

type Candidate = {
    sessionId: string;
    score: number;
};

const DEFAULT_SESSION_START_WINDOW_MS = 2 * 60 * 1000;

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const targetCwd = opts.cwd && opts.cwd.trim().length > 0 ? normalizePath(opts.cwd) : null;
    const resolvedSessionFile = opts.resolvedSessionFile ?? null;

    if (resolvedSessionFile) {
        if (resolvedSessionFile.status !== 'found') {
            const message = `Explicit Codex session resolution failed with status ${resolvedSessionFile.status}; refusing fallback.`;
            logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
            opts.onSessionMatchFailed?.(message);
            return {
                cleanup: async () => {},
                onNewSession: () => {}
            };
        }

        const scanner = new CodexSessionScannerImpl(opts, targetCwd, resolvedSessionFile.filePath);
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
    private readonly eventOwnerSessionIdByFile = new Map<string, Map<number, string | null>>();
    private readonly currentSegmentOwnerByFile = new Map<string, string | null>();
    private readonly inSessionMetaBlockByFile = new Map<string, boolean>();
    private readonly pendingEventsByFile = new Map<string, PendingEvents>();
    private readonly sessionMetaParsed = new Set<string>();
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly toolNameByCallId = new Map<string, string>();
    private readonly linkedChildFilePaths = new Set<string>();
    private readonly linkedChildParentCallIdByFile = new Map<string, string>();
    private readonly childTranscriptStartLineByFile = new Map<string, number>();
    private readonly pendingChildSessionIdToParentCallId = new Map<string, string>();
    private readonly targetCwd: string | null;
    private readonly referenceTimestampMs: number;
    private readonly sessionStartWindowMs: number;
    private readonly matchDeadlineMs: number;
    private readonly sessionDatePrefixes: Set<string> | null;
    private readonly explicitResolvedFilePath: string | null;
    private readonly explicitResumeMode: boolean;

    private activeSessionId: string | null;
    private reportedSessionId: string | null;
    private matchFailed = false;
    private bestWithinWindow: Candidate | null = null;
    private readonly recentActivitySessionIds = new Set<string>();
    private firstRecentActivityCandidateResolved = false;
    private readonly firstRecentActivitySessionIds = new Set<string>();
    private loggedAmbiguousRecentActivity = false;

    constructor(opts: CodexSessionScannerOptions, targetCwd: string | null, explicitResolvedFilePath: string | null = null) {
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
        this.explicitResolvedFilePath = explicitResolvedFilePath ? normalizePath(explicitResolvedFilePath) : null;
        this.explicitResumeMode = this.explicitResolvedFilePath !== null;
        this.sessionDatePrefixes = this.targetCwd
            ? (this.explicitResumeMode ? null : getSessionDatePrefixes(this.referenceTimestampMs, this.sessionStartWindowMs))
            : null;

        logger.debug(`[CODEX_SESSION_SCANNER] Init: targetCwd=${this.targetCwd ?? 'none'} startupTs=${new Date(this.referenceTimestampMs).toISOString()} windowMs=${this.sessionStartWindowMs}`);
    }

    public onNewSession(sessionId: string): void {
        if (this.explicitResumeMode) {
            return;
        }
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
        if (this.explicitResolvedFilePath) {
            const normalizedFilePath = normalizePath(filePath);
            return normalizedFilePath === this.explicitResolvedFilePath || this.linkedChildFilePaths.has(normalizedFilePath);
        }
        if (!this.activeSessionId) {
            if (!this.targetCwd) {
                return false;
            }
            return this.getCandidateForFile(filePath) !== null;
        }
        if (this.linkedChildFilePaths.has(normalizePath(filePath))) {
            return true;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId) {
            return fileSessionId === this.activeSessionId;
        }
        return filePath.endsWith(`-${this.activeSessionId}.jsonl`);
    }

    protected async initialize(): Promise<void> {
        const files = await this.getSessionFilesForScan();
        if (this.explicitResolvedFilePath) {
            for (const filePath of files) {
                if (this.shouldWatchFile(filePath)) {
                    this.ensureWatcher(filePath);
                }
            }
            return;
        }
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
        this.recentActivitySessionIds.clear();
    }

    protected async findSessionFiles(): Promise<string[]> {
        const files = await this.getSessionFilesForScan();
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

        if (this.explicitResolvedFilePath) {
            const emittedForFile = this.emitEvents(filePath, stats.entries, fileSessionId);
            if (normalizePath(filePath) === this.explicitResolvedFilePath) {
                await this.linkChildTranscriptsFromParentEntries(stats.entries);
                await this.linkPendingChildTranscripts();
            }
            if (emittedForFile > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
            }
            return;
        }

        if (!this.activeSessionId && this.targetCwd) {
            this.appendPendingEvents(filePath, stats.entries, fileSessionId);
            const candidate = this.getCandidateForFile(filePath);
            if (candidate) {
                if (!this.bestWithinWindow || candidate.score < this.bestWithinWindow.score) {
                    this.bestWithinWindow = candidate;
                }
            }
            const recentActivityCandidate = this.getRecentActivityCandidateForFile(filePath, stats.newCount);
            if (recentActivityCandidate) {
                this.recentActivitySessionIds.add(recentActivityCandidate.sessionId);
            }
            if (stats.newCount > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Buffered ${stats.newCount} pending events from ${filePath}`);
            }
            return;
        }

        const emittedForFile = this.emitEvents(filePath, stats.entries, fileSessionId);
        if (emittedForFile > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
        }
        const normalizedFilePath = normalizePath(filePath);
        if (!this.linkedChildFilePaths.has(normalizedFilePath)) {
            await this.linkChildTranscriptsFromParentEntries(stats.entries);
            await this.linkPendingChildTranscripts();
        }
    }

    protected async afterScan(): Promise<void> {
        if (this.explicitResolvedFilePath) {
            return;
        }
        if (!this.activeSessionId && this.targetCwd) {
            if (this.bestWithinWindow) {
                logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${this.bestWithinWindow.sessionId} within start window`);
                this.setActiveSessionId(this.bestWithinWindow.sessionId);
            } else {
                this.captureFirstRecentActivityCandidate();

                if (this.firstRecentActivitySessionIds.size === 1) {
                    const [sessionId] = this.firstRecentActivitySessionIds;
                    if (sessionId) {
                        logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${sessionId} from first unique matching activity after startup`);
                        this.setActiveSessionId(sessionId);
                    }
                } else if (
                    !this.loggedAmbiguousRecentActivity
                    && this.firstRecentActivityCandidateResolved
                    && this.firstRecentActivitySessionIds.size > 1
                ) {
                    this.loggedAmbiguousRecentActivity = true;
                    logger.debug('[CODEX_SESSION_SCANNER] First matching activity after startup was ambiguous; refusing reused-session adoption');
                }

                if (!this.activeSessionId) {
                    if (Date.now() > this.matchDeadlineMs) {
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
        }
    }

    private captureFirstRecentActivityCandidate(): void {
        if (this.firstRecentActivityCandidateResolved || this.recentActivitySessionIds.size === 0) {
            return;
        }

        this.firstRecentActivityCandidateResolved = true;
        for (const sessionId of this.recentActivitySessionIds) {
            this.firstRecentActivitySessionIds.add(sessionId);
        }
    }

    private shouldSkipFile(filePath: string): boolean {
        if (this.explicitResolvedFilePath) {
            const normalizedFilePath = normalizePath(filePath);
            return normalizedFilePath !== this.explicitResolvedFilePath && !this.linkedChildFilePaths.has(normalizedFilePath);
        }
        if (!this.activeSessionId) {
            return false;
        }
        const normalizedFilePath = normalizePath(filePath);
        if (this.linkedChildFilePaths.has(normalizedFilePath)) {
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

    private async getSessionFilesForScan(): Promise<string[]> {
        if (this.explicitResolvedFilePath) {
            return [this.explicitResolvedFilePath, ...this.linkedChildFilePaths];
        }
        return this.listSessionFiles(this.sessionsRoot);
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

        if (effectiveStartLine === 0) {
            this.sessionIdByFile.delete(filePath);
            this.sessionCwdByFile.delete(filePath);
            this.sessionTimestampByFile.delete(filePath);
            this.currentSegmentOwnerByFile.delete(filePath);
            this.inSessionMetaBlockByFile.delete(filePath);
            this.eventOwnerSessionIdByFile.set(filePath, new Map());
        }

        const hasSessionMeta = this.sessionMetaParsed.has(filePath);
        const parseFrom = hasSessionMeta ? effectiveStartLine : 0;
        let currentSegmentOwner = this.currentSegmentOwnerByFile.get(filePath) ?? null;
        let inSessionMetaBlock = this.inSessionMetaBlockByFile.get(filePath) ?? false;
        let eventOwnerByLine = this.eventOwnerSessionIdByFile.get(filePath);
        if (!eventOwnerByLine) {
            eventOwnerByLine = new Map();
            this.eventOwnerSessionIdByFile.set(filePath, eventOwnerByLine);
        }

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
                    if (sessionId && !this.sessionIdByFile.has(filePath)) {
                        this.sessionIdByFile.set(filePath, sessionId);
                    }
                    const sessionCwd = payload ? asString(payload.cwd) : null;
                    const normalizedCwd = sessionCwd ? normalizePath(sessionCwd) : null;
                    if (normalizedCwd && !this.sessionCwdByFile.has(filePath)) {
                        this.sessionCwdByFile.set(filePath, normalizedCwd);
                    }
                    const rawTimestamp = payload ? payload.timestamp : null;
                    const sessionTimestamp = payload ? parseTimestamp(payload.timestamp) : null;
                    if (sessionTimestamp !== null && !this.sessionTimestampByFile.has(filePath)) {
                        this.sessionTimestampByFile.set(filePath, sessionTimestamp);
                    }
                    if (!inSessionMetaBlock && sessionId) {
                        currentSegmentOwner = sessionId;
                    }
                    inSessionMetaBlock = true;
                    eventOwnerByLine.set(index, sessionId);
                    logger.debug(`[CODEX_SESSION_SCANNER] Session meta: file=${filePath} cwd=${sessionCwd ?? 'none'} normalizedCwd=${normalizedCwd ?? 'none'} timestamp=${rawTimestamp ?? 'none'} parsedTs=${sessionTimestamp ?? 'none'}`);
                    this.sessionMetaParsed.add(filePath);
                } else {
                    inSessionMetaBlock = false;
                    eventOwnerByLine.set(index, currentSegmentOwner);
                }
                if (index >= effectiveStartLine) {
                    events.push({ event: parsed, lineIndex: index });
                }
            } catch (error) {
                logger.debug(`[CODEX_SESSION_SCANNER] Failed to parse line: ${error}`);
            }
        }

        this.currentSegmentOwnerByFile.set(filePath, currentSegmentOwner);
        this.inSessionMetaBlockByFile.set(filePath, inSessionMetaBlock);

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

    private getRecentActivityCandidateForFile(filePath: string, newCount: number): Candidate | null {
        if (newCount <= 0) {
            return null;
        }

        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return null;
        }

        return {
            sessionId,
            score: 0
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

    private appendPendingEvents(
        filePath: string,
        entries: SessionFileScanEntry<CodexSessionEvent>[],
        fileSessionId: string | null
    ): void {
        if (entries.length === 0) {
            return;
        }
        const existing = this.pendingEventsByFile.get(filePath);
        if (existing) {
            existing.entries.push(...entries);
            if (!existing.fileSessionId && fileSessionId) {
                existing.fileSessionId = fileSessionId;
            }
            return;
        }
        this.pendingEventsByFile.set(filePath, {
            entries: [...entries],
            fileSessionId
        });
    }

    private emitEvents(
        filePath: string,
        entries: SessionFileScanEntry<CodexSessionEvent>[],
        fileSessionId: string | null
    ): number {
        let emittedForFile = 0;
        const eventOwnerByLine = this.eventOwnerSessionIdByFile.get(filePath);
        const normalizedFilePath = normalizePath(filePath);
        const linkedParentToolCallId = this.linkedChildParentCallIdByFile.get(normalizedFilePath) ?? null;
        const childStartLine = linkedParentToolCallId
            ? this.updateChildTranscriptBoundary(normalizedFilePath, entries)
            : null;
        if (linkedParentToolCallId && childStartLine === null) {
            return 0;
        }
        for (const entry of entries) {
            if (childStartLine !== null && entry.lineIndex !== undefined && entry.lineIndex < childStartLine) {
                continue;
            }
            const event = entry.event;
            const payload = asRecord(event.payload);
            const payloadSessionId = payload ? asString(payload.id) : null;
            const lineOwner = entry.lineIndex !== undefined
                ? (eventOwnerByLine?.get(entry.lineIndex) ?? null)
                : null;
            const eventSessionId = payloadSessionId ?? lineOwner ?? fileSessionId ?? null;

            if (this.activeSessionId && eventSessionId && eventSessionId !== this.activeSessionId && !linkedParentToolCallId) {
                continue;
            }

            const emittedEvent = linkedParentToolCallId
                ? {
                    ...event,
                    hapiSidechain: {
                        parentToolCallId: linkedParentToolCallId
                    }
                }
                : event;
            this.onEvent(emittedEvent);
            emittedForFile += 1;
        }
        return emittedForFile;
    }

    private async linkChildTranscriptsFromParentEntries(entries: SessionFileScanEntry<CodexSessionEvent>[]): Promise<void> {
        for (const entry of entries) {
            const event = entry.event;
            if (event.type !== 'response_item') {
                continue;
            }

            const payload = asRecord(event.payload);
            if (!payload) {
                continue;
            }

            const itemType = asString(payload.type);
            const callId = extractCallId(payload);
            if (!callId) {
                continue;
            }

            if (itemType === 'function_call') {
                const toolName = asString(payload.name);
                if (toolName) {
                    this.toolNameByCallId.set(callId, toolName);
                }
                continue;
            }

            if (itemType !== 'function_call_output' || this.toolNameByCallId.get(callId) !== 'spawn_agent') {
                continue;
            }

            const childSessionId = extractAgentIdFromOutput(payload.output);
            if (!childSessionId) {
                continue;
            }

            this.pendingChildSessionIdToParentCallId.set(childSessionId, callId);
        }
    }

    private async linkPendingChildTranscripts(): Promise<void> {
        if (this.pendingChildSessionIdToParentCallId.size === 0) {
            return;
        }

        for (const [childSessionId, parentToolCallId] of [...this.pendingChildSessionIdToParentCallId.entries()]) {
            const linked = await this.linkChildTranscript(childSessionId, parentToolCallId);
            if (linked) {
                this.pendingChildSessionIdToParentCallId.delete(childSessionId);
            }
        }
    }

    private async linkChildTranscript(childSessionId: string, parentToolCallId: string): Promise<boolean> {
        const childFilePath = await this.resolveChildTranscriptFilePath(childSessionId);
        if (!childFilePath) {
            return false;
        }

        const normalizedChildFilePath = normalizePath(childFilePath);
        if (this.linkedChildFilePaths.has(normalizedChildFilePath)) {
            return true;
        }

        this.linkedChildFilePaths.add(normalizedChildFilePath);
        this.linkedChildParentCallIdByFile.set(normalizedChildFilePath, parentToolCallId);
        this.ensureWatcher(childFilePath);

        const { events, nextCursor } = await this.readSessionFile(childFilePath, 0);
        const startLine = this.updateChildTranscriptBoundary(normalizedChildFilePath, events);
        if (startLine === null) {
            this.setCursor(childFilePath, nextCursor);
            return true;
        }

        this.childTranscriptStartLineByFile.set(normalizedChildFilePath, startLine);
        const childEntries = events.filter((entry) => entry.lineIndex !== undefined && entry.lineIndex >= startLine);
        const processedKeys = childEntries.map((entry) => this.generateEventKey(entry.event, {
            filePath: childFilePath,
            lineIndex: entry.lineIndex
        }));

        this.emitEvents(childFilePath, childEntries, childSessionId);
        this.setCursor(childFilePath, nextCursor);
        this.seedProcessedKeys(processedKeys);
        return true;
    }

    private updateChildTranscriptBoundary(
        normalizedFilePath: string,
        entries: SessionFileScanEntry<CodexSessionEvent>[]
    ): number | null {
        const existingStartLine = this.childTranscriptStartLineByFile.get(normalizedFilePath);
        if (existingStartLine !== undefined) {
            return existingStartLine;
        }

        for (const entry of entries) {
            const payload = asRecord(entry.event.payload);
            if (!payload || entry.lineIndex === undefined) {
                continue;
            }

            if (entry.event.type === 'response_item' && asString(payload.type) === 'function_call_output') {
                if (stringifyOutput(payload.output).startsWith('You are the newly spawned agent.')) {
                    const startLine = entry.lineIndex + 1;
                    this.childTranscriptStartLineByFile.set(normalizedFilePath, startLine);
                    return startLine;
                }
            }
        }

        return null;
    }

    private async resolveChildTranscriptFilePath(childSessionId: string): Promise<string | null> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        const suffix = `-${childSessionId}.jsonl`;
        const matches = files.filter((filePath) => filePath.endsWith(suffix));
        if (matches.length === 0) {
            return null;
        }
        matches.sort((left, right) => left.localeCompare(right));
        return matches[0] ?? null;
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
            emitted += this.emitEvents(filePath, pending.entries, pending.fileSessionId);
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

function extractCallId(payload: Record<string, unknown>): string | null {
    const candidates = ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id'];
    for (const key of candidates) {
        const value = payload[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return null;
}

function extractAgentIdFromOutput(output: unknown): string | null {
    if (output && typeof output === 'object') {
        return asString((output as Record<string, unknown>).agent_id);
    }

    if (typeof output === 'string') {
        const trimmed = output.trim();
        if (!trimmed) {
            return null;
        }
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === 'object') {
                return asString((parsed as Record<string, unknown>).agent_id);
            }
        } catch {
            return null;
        }
    }

    return null;
}

function stringifyOutput(output: unknown): string {
    if (typeof output === 'string') {
        return output;
    }
    if (output === null || output === undefined) {
        return '';
    }
    try {
        return JSON.stringify(output);
    } catch {
        return String(output);
    }
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
