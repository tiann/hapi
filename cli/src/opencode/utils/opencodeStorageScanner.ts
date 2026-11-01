import { logger } from '@/ui/logger';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isObject } from '@hapi/protocol';
import type { OpencodeHookEvent } from '../types';
import { Database } from 'bun:sqlite';

export type OpencodeStorageScannerHandle = {
    cleanup: () => Promise<void>;
    onNewSession: (sessionId: string) => void;
};

type OpencodeStorageScannerOptions = {
    sessionId: string | null;
    cwd: string;
    onEvent: (event: OpencodeHookEvent) => void;
    onSessionFound?: (sessionId: string) => void;
    onSessionMatchFailed?: (message: string) => void;
    storageDir?: string;
    intervalMs?: number;
    sessionStartWindowMs?: number;
    startupTimestampMs?: number;
};

type StorageSource = 'database' | 'files';

type SessionCandidate = {
    sessionId: string;
    score: number;
    source: StorageSource;
};

type DbSessionRow = {
    id: string;
    directory: string;
    time_created: number;
    time_updated: number;
};

type DbMessageRow = {
    id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
};

type DbPartRow = {
    id: string;
    message_id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
};

const DEFAULT_SESSION_START_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_SCAN_INTERVAL_MS = 2000;
const REPLAY_CLOCK_SKEW_MS = 2000;

export async function createOpencodeStorageScanner(
    opts: OpencodeStorageScannerOptions
): Promise<OpencodeStorageScannerHandle> {
    const scanner = new OpencodeStorageScanner(opts);
    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (sessionId: string) => {
            void scanner.onNewSession(sessionId);
        }
    };
}

class OpencodeStorageScanner {
    private readonly storageDir: string;
    private readonly databasePath: string;
    private readonly targetCwd: string | null;
    private readonly onEvent: (event: OpencodeHookEvent) => void;
    private readonly onSessionFound?: (sessionId: string) => void;
    private readonly onSessionMatchFailed?: (message: string) => void;
    private readonly referenceTimestampMs: number;
    private readonly sessionStartWindowMs: number;
    private readonly matchDeadlineMs: number;
    private readonly intervalMs: number;
    private readonly seedSessionId: string | null;

    private intervalId: ReturnType<typeof setInterval> | null = null;
    private activeSessionId: string | null = null;
    private activeStorageSource: StorageSource | null = null;
    private matchFailed = false;
    private warnedMissingStorage = false;
    private scanning = false;
    private db: Database | null = null;
    private dbReady = false;

    private readonly messageRoles = new Map<string, string>();
    private readonly summaryMessageIds = new Set<string>();
    private batchComplete = true;
    private sessionGeneration = 0;
    private readonly messageDbVersion = new Map<string, number>();
    private readonly partDbVersion = new Map<string, number>();

    constructor(opts: OpencodeStorageScannerOptions) {
        this.storageDir = opts.storageDir ?? resolveOpencodeStorageDir();
        this.databasePath = join(this.storageDir, '..', 'opencode.db');
        this.targetCwd = opts.cwd ? normalizePath(opts.cwd) : null;
        this.onEvent = opts.onEvent;
        this.onSessionFound = opts.onSessionFound;
        this.onSessionMatchFailed = opts.onSessionMatchFailed;
        this.referenceTimestampMs = opts.startupTimestampMs ?? Date.now();
        this.sessionStartWindowMs = opts.sessionStartWindowMs ?? DEFAULT_SESSION_START_WINDOW_MS;
        this.matchDeadlineMs = this.referenceTimestampMs + this.sessionStartWindowMs;
        this.intervalMs = opts.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
        this.seedSessionId = opts.sessionId;

        if (!this.targetCwd && !this.seedSessionId) {
            const message = 'No cwd/sessionId available for OpenCode storage matching; scanner disabled.';
            logger.warn(`[opencode-storage] ${message}`);
            this.matchFailed = true;
            this.onSessionMatchFailed?.(message);
        }
    }

    async start(): Promise<void> {
        if (this.matchFailed) {
            return;
        }
        try {
            await this.initializeDatabase();
        } catch (error) {
            logger.debug(`[opencode-storage] Failed to initialize database: ${error}`);
        }
        await this.scan();
        this.intervalId = setInterval(() => {
            void this.scan();
        }, this.intervalMs);
    }

    private async initializeDatabase(): Promise<void> {
        try {
            this.db = new Database(this.databasePath, { readonly: true });
            this.dbReady = true;
            logger.debug(`[opencode-storage] Connected to SQLite database: ${this.databasePath}`);
        } catch (error) {
            logger.debug(`[opencode-storage] SQLite database not available: ${error}`);
            this.db = null;
            this.dbReady = false;
        }
    }

    async cleanup(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.db) {
            try {
                this.db.close();
                this.db = null;
            } catch {
                // ignore
            }
        }
    }

    async onNewSession(sessionId: string): Promise<void> {
        if (!sessionId || sessionId === this.activeSessionId) {
            return;
        }
        await this.setActiveSession(sessionId);
    }

    private async scan(): Promise<void> {
        if (this.scanning || this.matchFailed) {
            return;
        }
        this.scanning = true;
        this.batchComplete = true;
        try {
            // Try to initialize database if not ready
            if (!this.dbReady && !this.db) {
                try {
                    await this.initializeDatabase();
                } catch {
                    // ignore, will use file-based fallback
                }
            }

            const storageReady = await this.ensureStorageDir();
            if (!storageReady && !this.dbReady) {
                return;
            }

            if (!this.activeSessionId) {
                await this.discoverSessionId();
            }

            if (this.activeSessionId) {
                const scannedSessionId = this.activeSessionId;
                const generation = this.sessionGeneration;
                await this.scanMessagesAndParts(scannedSessionId);
                if (this.batchComplete && generation === this.sessionGeneration && scannedSessionId === this.activeSessionId) {
                    this.onEvent({ event: 'transcript.scan.completed', sessionId: scannedSessionId, payload: {} });
                }
            }
        } finally {
            this.scanning = false;
        }
    }

    private async ensureStorageDir(): Promise<boolean> {
        try {
            const stats = await stat(this.storageDir);
            if (!stats.isDirectory()) {
                if (!this.warnedMissingStorage) {
                    this.warnedMissingStorage = true;
                    logger.debug(`[opencode-storage] Storage path is not a directory: ${this.storageDir}`);
                }
                return false;
            }
        } catch {
            if (!this.warnedMissingStorage) {
                this.warnedMissingStorage = true;
                logger.debug(`[opencode-storage] Storage path missing: ${this.storageDir}`);
            }
            return false;
        }

        if (this.warnedMissingStorage) {
            logger.debug(`[opencode-storage] Storage path ready: ${this.storageDir}`);
            this.warnedMissingStorage = false;
        }
        return true;
    }

    private async discoverSessionId(): Promise<void> {
        if (this.activeSessionId || this.matchFailed) {
            return;
        }

        if (this.seedSessionId) {
            await this.setActiveSession(this.seedSessionId);
            return;
        }

        if (!this.targetCwd) {
            const message = 'Missing cwd for OpenCode storage matching; refusing to guess session.';
            logger.warn(`[opencode-storage] ${message}`);
            this.matchFailed = true;
            this.onSessionMatchFailed?.(message);
            return;
        }

        let best: SessionCandidate | null = null;

        // Try SQLite database first (preferred method)
        if (this.dbReady && this.db) {
            best = await this.discoverSessionFromDatabase();
        }

        // Fall back to file-based storage if database lookup failed
        if (!best && (await this.ensureStorageDir())) {
            best = await this.discoverSessionFromFiles();
        }

        if (best) {
            await this.setActiveSession(best.sessionId, best.source);
            return;
        }

        if (Date.now() > this.matchDeadlineMs) {
            const message = `No OpenCode session found within ${this.sessionStartWindowMs}ms for cwd ${this.targetCwd}`;
            logger.warn(`[opencode-storage] ${message}`);
            this.matchFailed = true;
            this.onSessionMatchFailed?.(message);
        }
    }

    private async discoverSessionFromDatabase(): Promise<SessionCandidate | null> {
        if (!this.db || !this.targetCwd) {
            return null;
        }

        try {
            const query = this.db.prepare(`
                SELECT id, directory, time_created
                FROM session
                WHERE time_created >= ?
                  AND time_created <= ?
                ORDER BY time_created ASC
            `);
            const rows = query.all(
                this.referenceTimestampMs,
                this.referenceTimestampMs + this.sessionStartWindowMs
            ) as DbSessionRow[];

            let best: SessionCandidate | null = null;

            for (const row of rows) {
                if (!row.id || !row.directory || row.time_created === null) {
                    continue;
                }

                if (normalizePath(row.directory) !== this.targetCwd) {
                    continue;
                }

                const diff = row.time_created - this.referenceTimestampMs;
                if (!best || diff < best.score) {
                    best = { sessionId: row.id, score: diff, source: 'database' };
                }
            }

            if (best) {
                logger.debug(`[opencode-storage] Session discovered from SQLite database: ${best.sessionId}`);
            }

            return best;
        } catch (error) {
            logger.debug(`[opencode-storage] Database query failed: ${error}`);
            return null;
        }
    }

    private async discoverSessionFromFiles(): Promise<SessionCandidate | null> {
        const sessionFiles = await listSessionInfoFiles(this.storageDir);
        let best: SessionCandidate | null = null;

        for (const filePath of sessionFiles) {
            const info = await readSessionInfo(filePath);
            if (!info || !info.id || !info.directory || info.timeCreated === null) {
                continue;
            }

            if (normalizePath(info.directory) !== this.targetCwd) {
                continue;
            }

            if (info.timeCreated < this.referenceTimestampMs) {
                continue;
            }

            const diff = info.timeCreated - this.referenceTimestampMs;
            if (diff > this.sessionStartWindowMs) {
                continue;
            }

            if (!best || diff < best.score) {
                best = { sessionId: info.id, score: diff, source: 'files' };
            }
        }

        if (best) {
            logger.debug(`[opencode-storage] Session discovered from file storage: ${best.sessionId}`);
        }

        return best;
    }

    private async setActiveSession(sessionId: string, source?: StorageSource): Promise<void> {
        if (this.activeSessionId === sessionId && (!source || this.activeStorageSource === source)) {
            return;
        }
        const generation = ++this.sessionGeneration;
        this.activeSessionId = sessionId;
        this.messageRoles.clear();
        this.summaryMessageIds.clear();
        this.messageDbVersion.clear();
        this.partDbVersion.clear();
        this.activeStorageSource = null;

        const storageSource = source ?? await this.resolveStorageSourceForSession(sessionId);
        if (generation !== this.sessionGeneration) return;

        if (storageSource === 'database' && this.dbReady && this.db) {
            try {
                await this.primeSessionFilesFromDatabase(sessionId);
                if (this.batchComplete && generation === this.sessionGeneration) this.onEvent({ event: 'transcript.scan.completed', sessionId, payload: {} });
                if (generation !== this.sessionGeneration) return;
                this.activeStorageSource = 'database';
            } catch (error) {
                logger.debug(`[opencode-storage] Database priming failed, falling back to files: ${error}`);
                if (generation !== this.sessionGeneration) return;
                this.activeStorageSource = null;
            }
        }

        if (!this.activeStorageSource && await this.ensureStorageDir()) {
            await this.primeSessionFilesFromFiles(sessionId);
            if (this.batchComplete && generation === this.sessionGeneration) this.onEvent({ event: 'transcript.scan.completed', sessionId, payload: {} });
            if (generation !== this.sessionGeneration) return;
            this.activeStorageSource = 'files';
        }

        if (generation !== this.sessionGeneration) return;
        this.onSessionFound?.(sessionId);
        logger.debug(`[opencode-storage] Tracking session ${sessionId} (source: ${this.activeStorageSource})`);
    }

    private async resolveStorageSourceForSession(sessionId: string): Promise<StorageSource | null> {
        if (this.dbReady && this.db && this.databaseHasSession(sessionId)) {
            return 'database';
        }
        if (await this.sessionFilesExist(sessionId)) {
            return 'files';
        }
        if (this.dbReady && this.db) {
            return 'database';
        }
        if (await this.ensureStorageDir()) {
            return 'files';
        }
        return null;
    }

    private databaseHasSession(sessionId: string): boolean {
        if (!this.db) {
            return false;
        }

        try {
            const query = this.db.prepare(`
                SELECT 1
                FROM session
                WHERE id = ?
                LIMIT 1
            `);
            return Boolean(query.get(sessionId));
        } catch (error) {
            logger.debug(`[opencode-storage] Database session lookup failed: ${error}`);
            return false;
        }
    }

    private async sessionFilesExist(sessionId: string): Promise<boolean> {
        const messageDir = join(this.storageDir, 'message', sessionId);
        const messageFiles = await listJsonFiles(messageDir);
        if (messageFiles.length > 0) {
            return true;
        }

        const sessionFiles = await listSessionInfoFiles(this.storageDir);
        for (const filePath of sessionFiles) {
            const info = await readSessionInfo(filePath);
            if (info?.id === sessionId) {
                return true;
            }
        }

        return false;
    }

    private async primeSessionFilesFromDatabase(sessionId: string): Promise<void> {
        await this.scanMessagesAndPartsFromDatabase(sessionId, true);
    }

    private async primeSessionFilesFromFiles(sessionId: string): Promise<void> {
        await this.scanMessagesAndPartsFromFiles(sessionId, true);
    }

    private async scanMessagesAndParts(sessionId: string): Promise<void> {
        if (this.activeStorageSource === 'database' && this.dbReady && this.db) {
            await this.scanMessagesAndPartsFromDatabase(sessionId);
        } else if (this.activeStorageSource === 'files' || !this.activeStorageSource) {
            await this.scanMessagesAndPartsFromFiles(sessionId);
        }
    }

    private recordMessage(info: Record<string, unknown>, sessionId: string): void {
        const id = getString(info.id);
        const role = getString(info.role);
        if (id && role) this.messageRoles.set(id, role);
        if (id && info.summary === true) this.summaryMessageIds.add(id);
        this.onEvent({ event: 'message.updated', payload: { info }, sessionId });
    }

    private async scanMessagesAndPartsFromDatabase(sessionId: string, prime = false): Promise<void> {
        if (!this.db) { this.batchComplete = false; return; }
        try {
            const messages = this.db.prepare(`
                SELECT id, session_id, time_created, time_updated, data
                FROM message WHERE session_id = ? ORDER BY time_created ASC
            `).all(sessionId) as DbMessageRow[];
            const threshold = this.referenceTimestampMs - REPLAY_CLOCK_SKEW_MS;
            const replayIds = new Set(messages.filter(m => m.time_created >= threshold).map(m => m.id));
            for (const msg of messages) {
                if (!msg.id || (!prime && msg.time_updated <= (this.messageDbVersion.get(msg.id) ?? 0))) continue;
                try {
                    const parsed: unknown = JSON.parse(msg.data);
                    if (!isObject(parsed)) throw new Error('Invalid message record');
                    const info = { ...parsed, id: msg.id, sessionID: msg.session_id };
                    // Old metadata is needed to classify a compaction that
                    // finishes after attachment. Its ordinary text stays primed.
                    this.recordMessage(info, msg.session_id);
                    this.messageDbVersion.set(msg.id, msg.time_updated);
                } catch { this.batchComplete = false; }
            }
            const parts = this.db.prepare(`
                SELECT id, message_id, session_id, time_created, time_updated, data
                FROM part WHERE session_id = ? ORDER BY time_created ASC
            `).all(sessionId) as DbPartRow[];
            for (const row of parts) {
                if (!prime && row.time_updated <= (this.partDbVersion.get(row.id) ?? 0)) continue;
                try {
                    const parsed: unknown = JSON.parse(row.data);
                    if (!isObject(parsed)) throw new Error('Invalid part record');
                    const part: Record<string, unknown> = { ...parsed, id: row.id, messageID: row.message_id, sessionID: row.session_id };
                    if ((!prime || replayIds.has(row.message_id) || part.type === 'compaction') && this.shouldEmitPart(part, row.message_id)) {
                        this.onEvent({ event: 'message.part.updated', payload: { part }, sessionId: row.session_id });
                    }
                    // Failed reads must remain eligible at the same version.
                    this.partDbVersion.set(row.id, row.time_updated);
                } catch { this.batchComplete = false; }
            }
        } catch (error) {
            this.batchComplete = false;
            logger.debug(`[opencode-storage] Database scan failed: ${error}`);
            if (prime) throw error;
        }
    }

    private async scanFiles(path: string, required = true): Promise<string[]> {
        try {
            return (await readdir(path, { withFileTypes: true }))
                .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
                .map(entry => join(path, entry.name));
        } catch (error) {
            if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') this.batchComplete = false;
            return [];
        }
    }

    private async scanMessagesAndPartsFromFiles(sessionId: string, prime = false): Promise<void> {
        const generation = this.sessionGeneration;
        const files = await this.scanFiles(join(this.storageDir, 'message', sessionId));
        if (generation !== this.sessionGeneration) return;
        const ids: string[] = [];
        const replayIds = new Set<string>();
        const threshold = this.referenceTimestampMs - REPLAY_CLOCK_SKEW_MS;
        for (const path of files) {
            const id = filenameToId(path);
            if (id) ids.push(id);
            const mtime = await readMtime(path);
            if (sessionId !== this.activeSessionId || generation !== this.sessionGeneration) return;
            if (mtime === null) { this.batchComplete = false; continue; }
            if (!prime && mtime <= (this.messageDbVersion.get(path) ?? 0)) continue;
            const info = await readJsonRecord(path);
            if (sessionId !== this.activeSessionId || generation !== this.sessionGeneration) return;
            if (!info) { this.batchComplete = false; continue; }
            const messageId = getString(info.id) ?? id;
            const timestamp = getMessageTimestamp(info, mtime);
            if (messageId && timestamp !== null && timestamp >= threshold) replayIds.add(messageId);
            this.recordMessage(info, getString(info.sessionID) ?? sessionId);
            this.messageDbVersion.set(path, mtime);
        }
        for (const id of ids) {
            const parts = await this.scanFiles(join(this.storageDir, 'part', id), this.summaryMessageIds.has(id));
            if (generation !== this.sessionGeneration) return;
            for (const path of parts) {
                const mtime = await readMtime(path);
                if (generation !== this.sessionGeneration) return;
                if (mtime === null) { this.batchComplete = false; continue; }
                if (!prime && mtime <= (this.partDbVersion.get(path) ?? 0)) continue;
                const part = await readJsonRecord(path);
                if (sessionId !== this.activeSessionId || generation !== this.sessionGeneration) return;
                if (!part) { this.batchComplete = false; continue; }
                if ((!prime || replayIds.has(id) || part.type === 'compaction') && this.shouldEmitPart(part, id)) {
                    this.onEvent({ event: 'message.part.updated', payload: { part }, sessionId: getString(part.sessionID) ?? sessionId });
                }
                this.partDbVersion.set(path, mtime);
            }
        }
    }

    private shouldEmitPart(part: Record<string, unknown>, messageId: string): boolean {
        const partType = getString(part.type);
        if (!partType) {
            return false;
        }

        if (partType === 'compaction') return true;

        if (partType === 'text') {
            const text = getString(part.text);
            if (!text) {
                return false;
            }
            const role = this.messageRoles.get(messageId);
            if (role === 'user') {
                return true;
            }
            if (part.synthetic === true) {
                return true;
            }
            const time = isObject(part.time) ? part.time as Record<string, unknown> : null;
            const end = time ? getNumber(time.end) : null;
            return end !== null;
        }

        if (partType === 'tool') {
            return true;
        }

        return false;
    }
}

type ParsedSessionInfo = {
    id: string | null;
    directory: string | null;
    timeCreated: number | null;
};

async function readSessionInfo(filePath: string): Promise<ParsedSessionInfo | null> {
    const record = await readJsonRecord(filePath);
    if (!record) {
        return null;
    }
    const time = isObject(record.time) ? record.time as Record<string, unknown> : null;

    return {
        id: getString(record.id),
        directory: getString(record.directory),
        timeCreated: time ? getNumber(time.created) : null
    };
}

async function listSessionInfoFiles(storageDir: string): Promise<string[]> {
    const sessionRoot = join(storageDir, 'session');
    const entries = await safeReadDir(sessionRoot);
    const results: string[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const projectDir = join(sessionRoot, entry.name);
        const files = await listJsonFiles(projectDir);
        results.push(...files);
    }

    return results;
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
    const entries = await safeReadDir(dirPath);
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => join(dirPath, entry.name));
}

async function safeReadDir(dirPath: string): Promise<Dirent[]> {
    try {
        return await readdir(dirPath, { withFileTypes: true });
    } catch {
        return [] as Dirent[];
    }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
    try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch (error) {
        logger.debug(`[opencode-storage] Failed to read ${filePath}: ${error}`);
        return null;
    }
}

async function readMtime(filePath: string): Promise<number | null> {
    try {
        const stats = await stat(filePath);
        return stats.mtimeMs;
    } catch {
        return null;
    }
}

function resolveOpencodeStorageDir(): string {
    const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    return join(base, 'opencode', 'storage');
}

function normalizePath(value: string): string {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function filenameToId(filePath: string): string | null {
    if (!filePath.endsWith('.json')) {
        return null;
    }
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const name = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    return name.slice(0, -5) || null;
}

function getString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return null;
}

function getNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return null;
}

function getMessageTimestamp(info: Record<string, unknown> | null, mtime: number | null): number | null {
    if (info) {
        const time = isObject(info.time) ? info.time as Record<string, unknown> : null;
        const createdAt = time ? getNumber(time.created) : null;
        if (createdAt !== null) {
            return createdAt;
        }
    }
    return mtime;
}
