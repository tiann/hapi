import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Metadata } from '@/api/types';

type MetadataUpdater = {
    updateMetadata: (handler: (metadata: Metadata) => Metadata) => void
};

type ReadTitle = (threadId: string) => string | null;
type WriteTitle = (threadId: string, title: string) => boolean;
type SyncTitle = (client: MetadataUpdater, threadId: string) => Promise<boolean>;

function sqlString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

export function getDefaultCodexStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite');
}

export function getDefaultCodexSessionIndexPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.CODEX_HOME || join(homedir(), '.codex'), 'session_index.jsonl');
}

export function normalizeCodexThreadTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const trimmed = title.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isCodexBackedMetadata(metadata: Metadata): boolean {
    return metadata.flavor === 'codex'
        || Boolean(metadata.codexSessionId)
        || metadata.mirrorSource === 'codex-desktop-sync';
}

export function getHapiMetadataTitleForCodex(metadata: Metadata | null | undefined): string | null {
    if (!metadata) {
        return null;
    }
    return normalizeCodexThreadTitle(metadata.title ?? metadata.name);
}

function parseCodexSessionIndexUpdatedAtMs(value: unknown): number | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.replace(/\.(\d{3})\d+Z$/, '.$1Z');
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function getCodexSessionIndexPath(dbPath: string, sessionIndexPath?: string): string {
    return sessionIndexPath ?? (
        dbPath === getDefaultCodexStateDbPath()
            ? getDefaultCodexSessionIndexPath()
            : join(dirname(dbPath), 'session_index.jsonl')
    );
}

function readCodexSessionIndexThreadTitle(
    threadId: string,
    sessionIndexPath: string
): { title: string; updatedAtMs: number } | null {
    if (!threadId || !existsSync(sessionIndexPath)) {
        return null;
    }

    try {
        const lines = readFileSync(sessionIndexPath, 'utf8').trimEnd().split('\n');
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index]?.trim();
            if (!line) {
                continue;
            }
            let parsed: { id?: unknown; thread_name?: unknown; updated_at?: unknown };
            try {
                parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
            } catch {
                continue;
            }
            if (parsed.id !== threadId) {
                continue;
            }
            const title = normalizeCodexThreadTitle(parsed.thread_name);
            if (!title) {
                continue;
            }
            return {
                title,
                updatedAtMs: parseCodexSessionIndexUpdatedAtMs(parsed.updated_at) ?? 0
            };
        }
    } catch {
        return null;
    }

    return null;
}

export function readCodexThreadTitle(
    threadId: string,
    options?: { dbPath?: string; sessionIndexPath?: string }
): string | null {
    const dbPath = options?.dbPath ?? getDefaultCodexStateDbPath();
    if (!threadId || !existsSync(dbPath)) {
        return null;
    }

    try {
        const sessionIndexTitle = readCodexSessionIndexThreadTitle(
            threadId,
            getCodexSessionIndexPath(dbPath, options?.sessionIndexPath)
        );
        if (sessionIndexTitle) {
            return sessionIndexTitle.title;
        }

        const output = execFileSync('sqlite3', [
            '-json',
            dbPath,
            `select title from threads where id = ${sqlString(threadId)} limit 1`
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (!output) {
            return null;
        }

        const rows = JSON.parse(output) as Array<{ title?: unknown }>;
        return normalizeCodexThreadTitle(rows[0]?.title);
    } catch {
        return null;
    }
}

export function writeCodexThreadTitle(
    threadId: string,
    title: string,
    options?: { dbPath?: string; sessionIndexPath?: string; nowMs?: number }
): boolean {
    const normalized = normalizeCodexThreadTitle(title);
    const dbPath = options?.dbPath ?? getDefaultCodexStateDbPath();
    if (!threadId || !normalized || !existsSync(dbPath)) {
        return false;
    }

    const nowMs = options?.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const sessionIndexPath = getCodexSessionIndexPath(dbPath, options?.sessionIndexPath);

    try {
        const output = execFileSync('sqlite3', [
            '-json',
            dbPath,
            [
                `update threads`,
                `set title = ${sqlString(normalized)}, updated_at = ${nowSeconds}, updated_at_ms = ${nowMs}`,
                `where id = ${sqlString(threadId)} and (title is null or title != ${sqlString(normalized)});`,
                `select changes() as changes;`
            ].join(' ')
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        const rows = output ? JSON.parse(output) as Array<{ changes?: unknown }> : [];
        const sqliteChanged = Number(rows[0]?.changes ?? 0) > 0;
        const latestIndexTitle = readCodexSessionIndexThreadTitle(threadId, sessionIndexPath);
        const indexChanged = latestIndexTitle?.title !== normalized;
        if (indexChanged) {
            mkdirSync(dirname(sessionIndexPath), { recursive: true });
            appendFileSync(sessionIndexPath, JSON.stringify({
                id: threadId,
                thread_name: normalized,
                updated_at: new Date(nowMs).toISOString()
            }) + '\n');
        }
        return sqliteChanged || indexChanged;
    } catch {
        return false;
    }
}

export function applyCodexThreadTitleToMetadata(metadata: Metadata, title: unknown, titleUpdatedAt?: number): Metadata {
    const normalized = normalizeCodexThreadTitle(title);
    if (!normalized) {
        return metadata;
    }

    const shouldClearName = isCodexBackedMetadata(metadata) && Boolean(metadata.name);
    const nextTitleUpdatedAt = typeof titleUpdatedAt === 'number' ? titleUpdatedAt : metadata.titleUpdatedAt;
    if (
        metadata.title === normalized
        && !shouldClearName
        && metadata.titleUpdatedAt === nextTitleUpdatedAt
    ) {
        return metadata;
    }

    const next: Metadata = {
        ...metadata,
        title: normalized,
        ...(typeof titleUpdatedAt === 'number' ? { titleUpdatedAt } : {})
    };

    if (shouldClearName) {
        delete next.name;
    }

    return next;
}

export function applyHapiTitleToMetadata(metadata: Metadata, title: unknown, titleUpdatedAt = Date.now()): Metadata {
    const normalized = normalizeCodexThreadTitle(title);
    if (!normalized) {
        return metadata;
    }

    const next: Metadata = {
        ...metadata,
        title: normalized,
        titleUpdatedAt
    };

    if (isCodexBackedMetadata(next)) {
        delete next.name;
    }

    return next;
}

export async function syncHapiMetadataTitleToCodexThread(
    metadata: Metadata | null | undefined,
    options?: { writeTitle?: WriteTitle }
): Promise<boolean> {
    const threadId = metadata?.codexSessionId;
    const title = getHapiMetadataTitleForCodex(metadata);
    if (!threadId || !title) {
        return false;
    }

    return (options?.writeTitle ?? writeCodexThreadTitle)(threadId, title);
}

export async function syncCodexThreadTitleToMetadata(
    client: MetadataUpdater,
    threadId: string,
    options?: { readTitle?: ReadTitle }
): Promise<boolean> {
    const title = normalizeCodexThreadTitle((options?.readTitle ?? readCodexThreadTitle)(threadId));
    if (!title) {
        return false;
    }

    client.updateMetadata((metadata) => applyCodexThreadTitleToMetadata(metadata, title));
    return true;
}

export function createCodexThreadTitlePoller(options: {
    client: MetadataUpdater;
    getThreadId: () => string | null;
    intervalMs?: number;
    syncTitle?: SyncTitle;
}): { stop: () => void } {
    const syncTitle = options.syncTitle ?? syncCodexThreadTitleToMetadata;
    const interval = setInterval(() => {
        const threadId = options.getThreadId();
        if (!threadId) {
            return;
        }
        void syncTitle(options.client, threadId);
    }, options.intervalMs ?? 2_000);

    return {
        stop: () => clearInterval(interval)
    };
}
