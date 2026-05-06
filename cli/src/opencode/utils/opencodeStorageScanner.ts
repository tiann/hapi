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

type SessionCandidate = {
    sessionId: string;
    score: number;
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
    private matchFailed = false;
    private warnedMissingStorage = false;
    private scanning = false;
    private db: Database | null = null;
    private dbReady = false;

    private readonly messageRoles = new Map<string, string>();
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
        this.activeSessionId = opts.sessionId;

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
                await this.scanMessagesAndParts(this.activeSessionId);
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
            await this.setActiveSession(best.sessionId);
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
                WHERE directory = ?
                ORDER BY time_created DESC
                LIMIT 10
            `);
            const rows = query.all(this.targetCwd) as DbSessionRow[];

            let best: SessionCandidate | null = null;

            for (const row of rows) {
                if (!row.id || row.time_created === null) {
                    continue;
                }

                if (row.time_created < this.referenceTimestampMs) {
                    continue;
                }

                const diff = row.time_created - this.referenceTimestampMs;
                if (diff > this.sessionStartWindowMs) {
                    continue;
                }

                if (!best || diff < best.score) {
                    best = { sessionId: row.id, score: diff };
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
                best = { sessionId: info.id, score: diff };
            }
        }

        if (best) {
            logger.debug(`[opencode-storage] Session discovered from file storage: ${best.sessionId}`);
        }

        return best;
    }

    private async setActiveSession(sessionId: string): Promise<void> {
        if (this.activeSessionId === sessionId) {
            return;
        }
        this.activeSessionId = sessionId;
        this.messageRoles.clear();
        this.messageDbVersion.clear();
        this.partDbVersion.clear();

        // Try database-based priming first
        if (this.dbReady && this.db) {
            await this.primeSessionFilesFromDatabase(sessionId);
        } else {
            // Fall back to file-based priming
            await this.primeSessionFilesFromFiles(sessionId);
        }

        this.onSessionFound?.(sessionId);
        logger.debug(`[opencode-storage] Tracking session ${sessionId}`);
    }

    private async primeSessionFilesFromDatabase(sessionId: string): Promise<void> {
        if (!this.db) {
            return;
        }

        try {
            const messageQuery = this.db.prepare(`
                SELECT id, session_id, time_created, time_updated, data
                FROM message
                WHERE session_id = ?
                ORDER BY time_created ASC
            `);
            const messages = messageQuery.all(sessionId) as DbMessageRow[];
            const replayThresholdMs = this.referenceTimestampMs - REPLAY_CLOCK_SKEW_MS;
            const messageIds: string[] = [];

            for (const msg of messages) {
                if (msg.id) {
                    messageIds.push(msg.id);
                    this.messageDbVersion.set(msg.id, msg.time_updated);

                    if (msg.time_created >= replayThresholdMs) {
                        try {
                            const info = JSON.parse(msg.data) as Record<string, unknown>;
                            const role = getString(info.role);
                            if (role) {
                                this.messageRoles.set(msg.id, role);
                            }
                            this.onEvent({
                                event: 'message.updated',
                                payload: { info },
                                sessionId: sessionId || undefined
                            });
                        } catch {
                            // ignore JSON parse errors
                        }
                    }
                }
            }

            // Now load parts
            for (const messageId of messageIds) {
                const partQuery = this.db.prepare(`
                    SELECT id, message_id, session_id, time_created, time_updated, data
                    FROM part
                    WHERE message_id = ?
                    ORDER BY time_created ASC
                `);
                const parts = partQuery.all(messageId) as DbPartRow[];

                for (const partRow of parts) {
                    this.partDbVersion.set(partRow.id, partRow.time_updated);

                    try {
                        const part = JSON.parse(partRow.data) as Record<string, unknown>;
                        if (this.shouldEmitPart(part, messageId)) {
                            this.onEvent({
                                event: 'message.part.updated',
                                payload: { part },
                                sessionId: sessionId || undefined
                            });
                        }
                    } catch {
                        // ignore JSON parse errors
                    }
                }
            }

            logger.debug(`[opencode-storage] Primed ${messages.length} messages and parts from database`);
        } catch (error) {
            logger.debug(`[opencode-storage] Failed to prime from database: ${error}`);
        }
    }

    private async primeSessionFilesFromFiles(sessionId: string): Promise<void> {
        const messageDir = join(this.storageDir, 'message', sessionId);
        const messageFiles = await listJsonFiles(messageDir);
        const messageIds: string[] = [];
        const replayMessageIds = new Set<string>();
        const replayThresholdMs = this.referenceTimestampMs - REPLAY_CLOCK_SKEW_MS;

        for (const filePath of messageFiles) {
            const mtime = await readMtime(filePath);
            if (mtime !== null) {
                this.messageDbVersion.set(filePath, mtime);
            }
            const info = await readJsonRecord(filePath);
            const messageId = getString(info?.id) ?? filenameToId(filePath);
            if (messageId) {
                messageIds.push(messageId);
                const role = getString(info?.role);
                if (role) {
                    this.messageRoles.set(messageId, role);
                }
            }
            const timestamp = getMessageTimestamp(info, mtime);
            if (messageId && info && timestamp !== null && timestamp >= replayThresholdMs) {
                replayMessageIds.add(messageId);
                const eventSessionId = getString(info.sessionID) ?? sessionId;
                this.onEvent({
                    event: 'message.updated',
                    payload: { info },
                    sessionId: eventSessionId || undefined
                });
            }
        }

        for (const messageId of messageIds) {
            const partDir = join(this.storageDir, 'part', messageId);
            const partFiles = await listJsonFiles(partDir);
            for (const partPath of partFiles) {
                const mtime = await readMtime(partPath);
                if (mtime !== null) {
                    this.partDbVersion.set(partPath, mtime);
                }
                if (!replayMessageIds.has(messageId)) {
                    continue;
                }
                const part = await readJsonRecord(partPath);
                if (!part) {
                    continue;
                }
                if (!this.shouldEmitPart(part, messageId)) {
                    continue;
                }
                const eventSessionId = getString(part.sessionID) ?? sessionId;
                this.onEvent({
                    event: 'message.part.updated',
                    payload: { part },
                    sessionId: eventSessionId || undefined
                });
            }
        }
    }

    private async scanMessagesAndParts(sessionId: string): Promise<void> {
        // Try database-based scanning first
        if (this.dbReady && this.db) {
            await this.scanMessagesAndPartsFromDatabase(sessionId);
        } else {
            // Fall back to file-based scanning
            await this.scanMessagesAndPartsFromFiles(sessionId);
        }
    }

    private async scanMessagesAndPartsFromDatabase(sessionId: string): Promise<void> {
        if (!this.db) {
            return;
        }

        try {
            const messageQuery = this.db.prepare(`
                SELECT id, session_id, time_created, time_updated, data
                FROM message
                WHERE session_id = ?
                ORDER BY time_created ASC
            `);
            const messages = messageQuery.all(sessionId) as DbMessageRow[];

            for (const msg of messages) {
                if (!msg.id) {
                    continue;
                }

                const previous = this.messageDbVersion.get(msg.id) ?? 0;
                if (msg.time_updated <= previous) {
                    continue;
                }

                this.messageDbVersion.set(msg.id, msg.time_updated);

                try {
                    const info = JSON.parse(msg.data) as Record<string, unknown>;
                    const role = getString(info.role);
                    if (role) {
                        this.messageRoles.set(msg.id, role);
                    }

                    this.onEvent({
                        event: 'message.updated',
                        payload: { info },
                        sessionId: sessionId || undefined
                    });
                } catch {
                    // ignore JSON parse errors
                }
            }

            // Scan parts
            const partQuery = this.db.prepare(`
                SELECT id, message_id, session_id, time_created, time_updated, data
                FROM part
                WHERE session_id = ?
                ORDER BY time_created ASC
            `);
            const parts = partQuery.all(sessionId) as DbPartRow[];

            for (const partRow of parts) {
                const previous = this.partDbVersion.get(partRow.id) ?? 0;
                if (partRow.time_updated <= previous) {
                    continue;
                }

                this.partDbVersion.set(partRow.id, partRow.time_updated);

                try {
                    const part = JSON.parse(partRow.data) as Record<string, unknown>;
                    if (!this.shouldEmitPart(part, partRow.message_id)) {
                        continue;
                    }

                    this.onEvent({
                        event: 'message.part.updated',
                        payload: { part },
                        sessionId: sessionId || undefined
                    });
                } catch {
                    // ignore JSON parse errors
                }
            }
        } catch (error) {
            logger.debug(`[opencode-storage] Database scan failed: ${error}`);
        }
    }

    private async scanMessagesAndPartsFromFiles(sessionId: string): Promise<void> {
        const messageDir = join(this.storageDir, 'message', sessionId);
        const messageFiles = await listJsonFiles(messageDir);
        const messageIds: string[] = [];

        for (const filePath of messageFiles) {
            const messageIdFromPath = filenameToId(filePath);
            if (messageIdFromPath) {
                messageIds.push(messageIdFromPath);
            }

            const mtime = await readMtime(filePath);
            if (mtime === null) {
                continue;
            }
            const previous = this.messageDbVersion.get(filePath) ?? 0;
            if (mtime <= previous) {
                continue;
            }

            const info = await readJsonRecord(filePath);
            this.messageDbVersion.set(filePath, mtime);
            if (!info) {
                continue;
            }

            const messageId = getString(info.id) ?? messageIdFromPath;
            if (messageId) {
                const role = getString(info.role);
                if (role) {
                    this.messageRoles.set(messageId, role);
                }
            }

            const eventSessionId = getString(info.sessionID) ?? sessionId;
            this.onEvent({
                event: 'message.updated',
                payload: { info },
                sessionId: eventSessionId || undefined
            });
        }

        for (const messageId of messageIds) {
            const partDir = join(this.storageDir, 'part', messageId);
            const partFiles = await listJsonFiles(partDir);

            for (const partPath of partFiles) {
                const mtime = await readMtime(partPath);
                if (mtime === null) {
                    continue;
                }
                const previous = this.partDbVersion.get(partPath) ?? 0;
                if (mtime <= previous) {
                    continue;
                }

                const part = await readJsonRecord(partPath);
                this.partDbVersion.set(partPath, mtime);
                if (!part) {
                    continue;
                }

                if (!this.shouldEmitPart(part, messageId)) {
                    continue;
                }

                const eventSessionId = getString(part.sessionID) ?? sessionId;
                this.onEvent({
                    event: 'message.part.updated',
                    payload: { part },
                    sessionId: eventSessionId || undefined
                });
            }
        }
    }

    private shouldEmitPart(part: Record<string, unknown>, messageId: string): boolean {
        const partType = getString(part.type);
        if (!partType) {
            return false;
        }

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
