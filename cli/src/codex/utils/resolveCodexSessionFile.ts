import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

export type ResolveCodexSessionFileResult =
    | {
        status: 'found';
        filePath: string;
        cwd: string | null;
        timestamp: number | null;
    }
    | {
        status: 'not_found';
    }
    | {
        status: 'ambiguous';
        filePaths: string[];
    }
    | {
        status: 'invalid';
        filePath: string;
        reason: 'invalid_session_meta' | 'session_id_mismatch';
    };

export async function resolveCodexSessionFile(sessionId: string): Promise<ResolveCodexSessionFileResult> {
    const sessionsRoot = getCodexSessionsRoot();
    const suffix = `-${sessionId}.jsonl`;
    const files = (await collectJsonlFiles(sessionsRoot))
        .filter((filePath) => filePath.endsWith(suffix))
        .sort((a, b) => a.localeCompare(b));

    if (files.length === 0) {
        return { status: 'not_found' };
    }

    const candidates = await Promise.all(files.map(async (filePath) => validateSessionMeta(filePath, sessionId)));
    const validCandidates = candidates.filter((candidate): candidate is ValidSessionFileCandidate => candidate.status === 'found');
    const invalidCandidates = candidates.filter((candidate): candidate is InvalidSessionFileCandidate => candidate.status === 'invalid');

    if (validCandidates.length === 1) {
        return validCandidates[0];
    }

    if (validCandidates.length > 1) {
        return {
            status: 'ambiguous',
            filePaths: validCandidates.map((candidate) => candidate.filePath)
        };
    }

    if (files.length === 1) {
        return invalidCandidates[0] ?? { status: 'invalid', filePath: files[0], reason: 'invalid_session_meta' };
    }

    return {
        status: 'ambiguous',
        filePaths: files
    };
}

function getCodexSessionsRoot(): string {
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    return join(codexHome, 'sessions');
}

async function collectJsonlFiles(root: string): Promise<string[]> {
    try {
        const entries = await readdir(root, { withFileTypes: true });
        const files: string[] = [];

        for (const entry of entries) {
            const fullPath = join(root, entry.name);
            if (entry.isDirectory()) {
                files.push(...await collectJsonlFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(fullPath);
            }
        }

        return files;
    } catch {
        return [];
    }
}

type ValidSessionFileCandidate = {
    status: 'found';
    filePath: string;
    cwd: string | null;
    timestamp: number | null;
};

type InvalidSessionFileCandidate = {
    status: 'invalid';
    filePath: string;
    reason: 'invalid_session_meta' | 'session_id_mismatch';
};

async function validateSessionMeta(filePath: string, sessionId: string): Promise<ValidSessionFileCandidate | InvalidSessionFileCandidate> {
    let content: string;
    try {
        content = await readFile(filePath, 'utf-8');
    } catch {
        return { status: 'invalid', filePath, reason: 'invalid_session_meta' };
    }

    const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) {
        return { status: 'invalid', filePath, reason: 'invalid_session_meta' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(firstLine);
    } catch {
        return { status: 'invalid', filePath, reason: 'invalid_session_meta' };
    }

    if (!isSessionMeta(parsed)) {
        return { status: 'invalid', filePath, reason: 'invalid_session_meta' };
    }

    const payload = parsed.payload;
    if (payload.id !== sessionId) {
        return { status: 'invalid', filePath, reason: 'session_id_mismatch' };
    }

    return {
        status: 'found',
        filePath,
        cwd: parseOptionalString(payload.cwd),
        timestamp: parseOptionalTimestamp(payload.timestamp)
    };
}

function isSessionMeta(value: unknown): value is { type: 'session_meta'; payload: { id: string; cwd?: unknown; timestamp?: unknown } } {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const record = value as Record<string, unknown>;
    if (record.type !== 'session_meta') {
        return false;
    }

    const payload = record.payload;
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const payloadRecord = payload as Record<string, unknown>;
    return typeof payloadRecord.id === 'string' && payloadRecord.id.length > 0;
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

function parseOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseOptionalTimestamp(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return parseTimestamp(value);
}
