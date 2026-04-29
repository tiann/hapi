import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promises as fs } from 'node:fs';

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
    updatedAt: number;
    path: string | null;
    model: string | null;
};

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

async function walkJsonlFiles(rootDir: string, maxFiles: number): Promise<string[]> {
    const queue: string[] = [rootDir];
    const files: string[] = [];

    while (queue.length > 0 && files.length < maxFiles) {
        const current = queue.shift();
        if (!current) {
            break;
        }

        let entries: fs.Dirent[];
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

function parseSessionLine(line: string): { id?: string; title?: string; path?: string; model?: string } | null {
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
        if (messageType === 'agent_message') {
            const text = asNonEmptyString(payload?.message) ?? asNonEmptyString(payload?.text);
            if (text) {
                return { title: text.slice(0, 80) };
            }
        }

        if (messageType === 'thread_started') {
            const id = asNonEmptyString(payload?.thread_id) ?? asNonEmptyString(payload?.threadId) ?? asNonEmptyString(payload?.id);
            return id ? { id } : null;
        }
    }

    return null;
}

async function parseSessionFile(filePath: string): Promise<RawSession | null> {
    let stat: fs.Stats;
    let content: string;
    try {
        [stat, content] = await Promise.all([
            fs.stat(filePath),
            fs.readFile(filePath, 'utf8')
        ]);
    } catch {
        return null;
    }

    const lines = content.split('\n').filter((line) => line.trim().length > 0).slice(0, 400);
    let id: string | null = null;
    let title: string | null = null;
    let path: string | null = null;
    let model: string | null = null;

    for (const line of lines) {
        const parsed = parseSessionLine(line);
        if (!parsed) {
            continue;
        }
        if (!id && parsed.id) {
            id = parsed.id;
        }
        if (!title && parsed.title) {
            title = parsed.title;
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
        updatedAt: Math.max(0, Math.floor(stat.mtimeMs)),
        path,
        model
    };
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
    const files = await walkJsonlFiles(sessionsDir, 5000);
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
            title: entry.title,
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
