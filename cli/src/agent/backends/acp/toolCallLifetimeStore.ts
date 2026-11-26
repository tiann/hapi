import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveHapiHomeDir } from '@/configuration';
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv';
import { isObject } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import type { StoredToolCallLifetime } from './toolCallLifetimes';

/**
 * Where the open tool call lifetimes of an ACP session survive a restart.
 * `append` records one opened lifetime and `appendClose` one finished
 * lifetime, both O(1); `save` writes the whole open set as the new snapshot
 * and drops the appended records (an empty set removes the session's record
 * entirely); `load` is the snapshot with the records appended since replayed
 * in order: a later open of the same scope and agent id replaces an earlier
 * one, and a close removes its lifetime.
 */
export type ToolCallLifetimeStore = {
    load(acpSessionId: string): StoredToolCallLifetime[];
    append(acpSessionId: string, lifetime: StoredToolCallLifetime): void;
    appendClose(acpSessionId: string, lifetimeId: string): void;
    save(acpSessionId: string, lifetimes: StoredToolCallLifetime[]): void;
};

type JournalRecord = { open: StoredToolCallLifetime } | { closed: string };

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function parseEntry(entry: unknown): StoredToolCallLifetime | null {
    if (!isObject(entry)) return null;
    const { agentToolCallId, scope, id } = entry;
    if (typeof agentToolCallId !== 'string' || typeof scope !== 'string' || typeof id !== 'string') return null;
    return { agentToolCallId, scope, id, ...(typeof entry.openedAt === 'number' ? { openedAt: entry.openedAt } : {}) };
}

function readSnapshot(path: string): StoredToolCallLifetime[] {
    try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!isObject(value) || !Array.isArray(value.lifetimes)) return [];
        return value.lifetimes.flatMap((entry) => parseEntry(entry) ?? []);
    } catch {
        return [];
    }
}

function readJournal(path: string): JournalRecord[] {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    return text.split('\n').flatMap((line): JournalRecord[] => {
        if (!line.trim()) return [];
        try {
            const value: unknown = JSON.parse(line);
            if (isObject(value) && typeof value.closed === 'string') return [{ closed: value.closed }];
            const open = parseEntry(value);
            return open ? [{ open }] : [];
        } catch {
            // A torn line from a crash mid-append.
            return [];
        }
    });
}

function replay(snapshot: StoredToolCallLifetime[], journal: JournalRecord[]): StoredToolCallLifetime[] {
    const byKey = new Map<string, StoredToolCallLifetime>();
    const keyOf = (entry: StoredToolCallLifetime) => `${entry.scope}\u0000${entry.agentToolCallId}`;
    const put = (entry: StoredToolCallLifetime) => {
        // Last wins: the newest lifetime of a reused id is the one in flight.
        byKey.delete(keyOf(entry));
        byKey.set(keyOf(entry), entry);
    };
    snapshot.forEach(put);
    for (const record of journal) {
        if ('open' in record) {
            put(record.open);
            continue;
        }
        for (const [key, entry] of byKey) {
            if (entry.id === record.closed) byKey.delete(key);
        }
    }
    return [...byKey.values()];
}

/**
 * Narrows the modes of the store directory and this session's own files when
 * an older build created them wider (mode only applies on creation). Errors
 * such as EPERM are ignored; Windows has no POSIX modes.
 */
function tightenModes(directory: string, base: string): void {
    if (process.platform === 'win32') return;
    for (const [path, mode] of [[directory, DIRECTORY_MODE], [`${base}.json`, FILE_MODE], [`${base}.journal`, FILE_MODE]] as const) {
        try {
            chmodSync(path, mode);
        } catch {
            // Missing or not ours to change.
        }
    }
}

/** Temporary snapshot files of this record left by a crash between write and rename. */
function removeOrphanedTemporaryFiles(base: string): void {
    const prefix = `${basename(base)}.`;
    let names: string[];
    try {
        names = readdirSync(dirname(base));
    } catch {
        return;
    }
    for (const name of names) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) {
            rmSync(join(dirname(base), name), { force: true });
        }
    }
}

/**
 * Per ACP session, a JSON snapshot plus an append-only journal under the HAPI
 * home of this machine (the agent process is a child of this CLI process, so
 * the session resumes on the same machine). Files are only ever removed by
 * their own session: on a clean exit, or when its open set becomes empty.
 * Nothing sweeps other sessions' files by age, since an idle session may still
 * be live. A record left by a crash stays until that session runs again.
 */
export function createFileToolCallLifetimeStore(directory: string, namespace = ''): ToolCallLifetimeStore {
    const baseFor = (acpSessionId: string) =>
        join(directory, createHash('sha256').update(`${namespace}\u0000${acpSessionId}`).digest('hex').slice(0, 40));
    const fail = (error: unknown) =>
        logger.debug('[ACP] Failed to persist tool call lifetimes', error instanceof Error ? error.message : String(error));
    const tightened = new Set<string>();
    const tightenOnce = (acpSessionId: string) => {
        const base = baseFor(acpSessionId);
        if (tightened.has(base)) return;
        tightened.add(base);
        tightenModes(directory, base);
    };
    const appendRecord = (acpSessionId: string, record: unknown) => {
        tightenOnce(acpSessionId);
        try {
            mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
            // The leading newline ends a line torn by a crash, so this record
            // never merges into it; empty lines are skipped on load.
            appendFileSync(`${baseFor(acpSessionId)}.journal`, `\n${JSON.stringify(record)}`, { mode: FILE_MODE });
        } catch (error) {
            fail(error);
        }
    };
    return {
        load(acpSessionId) {
            const base = baseFor(acpSessionId);
            tightenOnce(acpSessionId);
            try {
                removeOrphanedTemporaryFiles(base);
            } catch (error) {
                fail(error);
            }
            return replay(readSnapshot(`${base}.json`), readJournal(`${base}.journal`));
        },
        append(acpSessionId, lifetime) {
            appendRecord(acpSessionId, lifetime);
        },
        appendClose(acpSessionId, lifetimeId) {
            appendRecord(acpSessionId, { closed: lifetimeId });
        },
        save(acpSessionId, lifetimes) {
            const base = baseFor(acpSessionId);
            tightenOnce(acpSessionId);
            try {
                if (lifetimes.length === 0) {
                    rmSync(`${base}.json`, { force: true });
                } else {
                    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
                    const temp = `${base}.${randomUUID()}.tmp`;
                    writeFileSync(temp, JSON.stringify({ version: 1, lifetimes }), { mode: FILE_MODE });
                    renameSync(temp, `${base}.json`);
                }
                // Only after the snapshot holds everything the journal did.
                rmSync(`${base}.journal`, { force: true });
            } catch (error) {
                fail(error);
            }
        }
    };
}

/**
 * The store for this process: per HAPI session, so only a real session (one
 * that exported its id at bootstrap) persists anything.
 */
export function defaultToolCallLifetimeStore(env: NodeJS.ProcessEnv = process.env): ToolCallLifetimeStore | null {
    const hapiSessionId = env[HAPI_SESSION_ID_ENV];
    if (!hapiSessionId) return null;
    return createFileToolCallLifetimeStore(join(resolveHapiHomeDir(env), 'acp-tool-call-lifetimes'), hapiSessionId);
}
