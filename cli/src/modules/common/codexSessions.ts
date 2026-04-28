import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';

export interface CodexSessionSummary {
    id: string;
    title: string;
    updatedAt: number;
    path: string | null;
    model: string | null;
    isOld: boolean;
}

export interface ListCodexSessionsRequest {
    includeOld?: boolean;
    olderThanDays?: number;
    limit?: number;
    cursor?: string;
}

export interface ListCodexSessionsResponse {
    success: boolean;
    sessions?: CodexSessionSummary[];
    nextCursor?: string | null;
    error?: string;
}

type RawSession = {
    id: string;
    title: string;
    titleSource: TitleSource;
    updatedAt: number;
    path: string | null;
    model: string | null;
};

type IndexedSessionTitle = {
    title: string;
    updatedAt: number;
};

type SqliteDatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => {
    query: (sql: string) => { all: () => unknown[] };
    close: (throwOnError?: boolean) => void;
};

type TitleSource = 'generated' | 'user' | 'agent' | 'fallback';

export function formatCodexSessionTitle(text: string): string | null {
    const title = text.replace(/\s+/g, ' ').trim();
    return title.length > 0 ? title.slice(0, 80) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCodexHome(): string {
    return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function parseIndexUpdatedAt(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

async function walkJsonlFiles(rootDir: string, maxFiles: number): Promise<string[]> {
    const queue: string[] = [rootDir];
    const files: string[] = [];

    while (queue.length > 0 && files.length < maxFiles) {
        const current = queue.shift();
        if (!current) {
            break;
        }

        let entries: Dirent[];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const fullPath = join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (entry.isFile() && extname(entry.name) === '.jsonl') {
                files.push(fullPath);
                if (files.length >= maxFiles) {
                    break;
                }
            }
        }
    }

    return files;
}

async function readJsonlLines(filePath: string): Promise<string[] | null> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return content.split('\n').filter((line) => line.trim().length > 0);
    } catch {
        return null;
    }
}

function titleSourcePriority(source: TitleSource | undefined): number {
    switch (source) {
        case 'generated':
            return 3;
        case 'user':
            return 2;
        case 'agent':
            return 1;
        default:
            return 0;
    }
}

function parseSessionLine(line: string): { id?: string; title?: string; titleSource?: TitleSource; path?: string; model?: string } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }

    const record = asRecord(parsed);
    if (!record) {
        return null;
    }

    const type = asNonEmptyString(record.type);
    const payload = asRecord(record.payload);

    if (type === 'session_meta') {
        const id = asNonEmptyString(payload?.id) ?? asNonEmptyString(record.id);
        const path = asNonEmptyString(payload?.cwd) ?? asNonEmptyString(payload?.path);
        const model = asNonEmptyString(payload?.model);
        return { id: id ?? undefined, path: path ?? undefined, model: model ?? undefined };
    }

    if (type === 'event_msg') {
        const messageType = asNonEmptyString(payload?.type);
        if (messageType === 'thread_name_updated') {
            const id = asNonEmptyString(payload?.thread_id) ?? asNonEmptyString(payload?.threadId) ?? asNonEmptyString(payload?.id);
            const text = asNonEmptyString(payload?.thread_name) ?? asNonEmptyString(payload?.threadName) ?? asNonEmptyString(payload?.title);
            const title = text ? formatCodexSessionTitle(text) : null;
            if (title) {
                return { id: id ?? undefined, title, titleSource: 'generated' };
            }
        }

        if (messageType === 'user_message') {
            const text = asNonEmptyString(payload?.message) ?? asNonEmptyString(payload?.text) ?? asNonEmptyString(payload?.content);
            const title = text ? formatCodexSessionTitle(text) : null;
            if (title) {
                return { title, titleSource: 'user' };
            }
        }

        if (messageType === 'agent_message') {
            const text = asNonEmptyString(payload?.message) ?? asNonEmptyString(payload?.text);
            const title = text ? formatCodexSessionTitle(text) : null;
            if (title) {
                return { title, titleSource: 'agent' };
            }
        }

        if (messageType === 'thread_started') {
            const id = asNonEmptyString(payload?.thread_id) ?? asNonEmptyString(payload?.threadId) ?? asNonEmptyString(payload?.id);
            return id ? { id } : null;
        }
    }

    return null;
}

function parseSessionIndexLine(line: string): { id: string; title: string; updatedAt: number } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }

    const record = asRecord(parsed);
    if (!record) {
        return null;
    }

    const id = asNonEmptyString(record.id) ?? asNonEmptyString(record.session_id) ?? asNonEmptyString(record.sessionId);
    const title = asNonEmptyString(record.thread_name) ?? asNonEmptyString(record.title) ?? asNonEmptyString(record.name);
    if (!id || !title) {
        return null;
    }

    return {
        id,
        title: formatCodexSessionTitle(title) ?? title,
        updatedAt: parseIndexUpdatedAt(record.updated_at ?? record.updatedAt ?? record.ts)
    };
}

async function readCodexSessionIndex(): Promise<Map<string, IndexedSessionTitle>> {
    const lines = await readJsonlLines(join(readCodexHome(), 'session_index.jsonl'));
    const titles = new Map<string, IndexedSessionTitle>();
    if (!lines) {
        return titles;
    }

    for (const line of lines) {
        const parsed = parseSessionIndexLine(line);
        if (!parsed) {
            continue;
        }
        const existing = titles.get(parsed.id);
        if (!existing || existing.updatedAt <= parsed.updatedAt) {
            titles.set(parsed.id, {
                title: parsed.title,
                updatedAt: parsed.updatedAt
            });
        }
    }
    return titles;
}

async function loadBunSqliteDatabase(): Promise<SqliteDatabaseConstructor | null> {
    try {
        const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ Database: SqliteDatabaseConstructor }>;
        return (await dynamicImport('bun:sqlite')).Database;
    } catch {
        return null;
    }
}

async function readCodexThreadTitles(): Promise<Map<string, IndexedSessionTitle>> {
    const titles = new Map<string, IndexedSessionTitle>();
    const Database = await loadBunSqliteDatabase();
    if (!Database) {
        return titles;
    }

    let db: InstanceType<SqliteDatabaseConstructor> | null = null;
    try {
        db = new Database(join(readCodexHome(), 'state_5.sqlite'), { readonly: true });
        const rows = db.query(`
            SELECT id, title, updated_at, updated_at_ms
            FROM threads
            WHERE title IS NOT NULL AND title != ''
        `).all() as Array<{ id: unknown; title: unknown; updated_at: unknown; updated_at_ms: unknown }>;

        for (const row of rows) {
            const id = asNonEmptyString(row.id);
            const title = asNonEmptyString(row.title);
            if (!id || !title) {
                continue;
            }
            titles.set(id, {
                title: formatCodexSessionTitle(title) ?? title,
                updatedAt: parseIndexUpdatedAt(row.updated_at_ms ?? row.updated_at)
            });
        }
    } catch {
        return titles;
    } finally {
        db?.close(false);
    }
    return titles;
}

async function parseSessionFile(filePath: string): Promise<RawSession | null> {
    let stat: Stats;
    let lines: string[] | null;
    try {
        [stat, lines] = await Promise.all([
            fs.stat(filePath),
            readJsonlLines(filePath)
        ]);
    } catch {
        return null;
    }
    if (!lines) {
        return null;
    }

    let id: string | null = null;
    let title: string | null = null;
    let titleSource: TitleSource = 'fallback';
    let path: string | null = null;
    let model: string | null = null;

    for (const line of lines.slice(0, 400)) {
        const parsed = parseSessionLine(line);
        if (!parsed) {
            continue;
        }
        if (!id && parsed.id) {
            id = parsed.id;
        }
        if (parsed.title && (!title || titleSourcePriority(parsed.titleSource) > titleSourcePriority(titleSource))) {
            title = parsed.title;
            titleSource = parsed.titleSource ?? titleSource;
        }
        if (!path && parsed.path) {
            path = parsed.path;
        }
        if (!model && parsed.model) {
            model = parsed.model;
        }
    }

    const fallbackId = basename(filePath, extname(filePath));
    const resolvedId = id ?? fallbackId;
    if (!resolvedId) {
        return null;
    }

    return {
        id: resolvedId,
        title: title ?? resolvedId,
        titleSource: title ? titleSource : 'fallback',
        updatedAt: Math.max(0, Math.floor(stat.mtimeMs)),
        path,
        model
    };
}

export async function findCodexSessionFile(sessionId: string): Promise<string | null> {
    if (!sessionId.trim()) {
        return null;
    }

    const sessionsDir = join(readCodexHome(), 'sessions');
    const files = await walkJsonlFiles(sessionsDir, 5000);
    for (const filePath of files) {
        const lines = await readJsonlLines(filePath);
        if (!lines) {
            continue;
        }
        for (const line of lines.slice(0, 400)) {
            const parsed = parseSessionLine(line);
            if (parsed?.id === sessionId) {
                return filePath;
            }
        }
    }
    return null;
}

export async function findCodexSessionTitle(sessionId: string): Promise<string | null> {
    if (!sessionId.trim()) {
        return null;
    }

    const indexedTitle = (await readCodexSessionIndex()).get(sessionId)?.title;
    if (indexedTitle) {
        return indexedTitle;
    }

    const sessionFile = await findCodexSessionFile(sessionId);
    const parsedSession = sessionFile ? await parseSessionFile(sessionFile) : null;
    if (parsedSession?.titleSource === 'generated') {
        return parsedSession.title;
    }

    const threadTitle = (await readCodexThreadTitles()).get(sessionId)?.title;
    if (threadTitle) {
        return threadTitle;
    }

    return parsedSession?.title ?? null;
}

export async function listCodexSessions(request: ListCodexSessionsRequest = {}): Promise<{ sessions: CodexSessionSummary[]; nextCursor: string | null }> {
    const includeOld = request.includeOld === true;
    const olderThanDays = Number.isFinite(request.olderThanDays) && (request.olderThanDays ?? 0) > 0
        ? Number(request.olderThanDays)
        : 180;
    const limit = Number.isFinite(request.limit) && (request.limit ?? 0) > 0
        ? Math.min(100, Math.floor(Number(request.limit)))
        : 50;
    const offset = Number.isFinite(Number(request.cursor)) && Number(request.cursor) >= 0
        ? Math.floor(Number(request.cursor))
        : 0;

    const sessionsDir = join(readCodexHome(), 'sessions');
    const [files, indexedTitles, threadTitles] = await Promise.all([
        walkJsonlFiles(sessionsDir, 5000),
        readCodexSessionIndex(),
        readCodexThreadTitles()
    ]);
    const raw = (await Promise.all(files.map((filePath) => parseSessionFile(filePath))))
        .filter((entry): entry is RawSession => entry !== null);

    const deduped = new Map<string, RawSession>();
    for (const entry of raw) {
        const existing = deduped.get(entry.id);
        if (!existing || existing.updatedAt < entry.updatedAt) {
            deduped.set(entry.id, entry);
        }
    }

    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const sorted = Array.from(deduped.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((entry) => ({
            id: entry.id,
            title: indexedTitles.get(entry.id)?.title
                ?? (entry.titleSource === 'generated' ? entry.title : undefined)
                ?? threadTitles.get(entry.id)?.title
                ?? entry.title,
            updatedAt: entry.updatedAt,
            path: entry.path,
            model: entry.model,
            isOld: entry.updatedAt < cutoff
        }));

    const filtered = includeOld ? sorted : sorted.filter((entry) => !entry.isOld);
    const sliced = filtered.slice(offset, offset + limit);
    const nextOffset = offset + sliced.length;

    return {
        sessions: sliced,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : null
    };
}
