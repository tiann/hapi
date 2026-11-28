import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { getProcessStartMarker, isProcessAlive, isWindows } from '@/utils/process';
import { readOwnershipProcessSnapshot, snapshotGenerationMayBeAlive } from './ownershipLiveness';
import { windowsGenerationMayBeAlive, type WindowsProcessTable } from '@/utils/windowsProcessStop';
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock';

const RuntimeSchema = z.object({
    id: z.string(), pid: z.number().int().positive(), marker: z.string(),
    kind: z.literal('attached').optional(), nativeEndpoint: z.string().optional(), attachedAt: z.number().optional(), supersedes: z.string().optional(),
    serverPid: z.number().int().positive().optional(), serverMarker: z.string().optional(),
    endpoint: z.string(), token: z.string().optional(),
    command: z.string(), args: z.array(z.string()), codexHome: z.string(), hub: z.string(), authHash: z.string(),
    pendingCreations: z.array(z.string()).optional(),
    sessions: z.record(z.string(), z.object({ threadId: z.string(), namespace: z.string(), active: z.boolean() }))
}).refine(value => value.kind !== 'attached' || (!value.serverPid && !value.serverMarker && value.command === '' && value.args.length === 0),
    'An attached worker must not record an owned server or executable');
export type CodexRuntimeRecord = z.infer<typeof RuntimeSchema>;

export function runtimeDirectory(): string {
    return join(configuration.happyHomeDir, 'codex-runtimes');
}
export function runtimeAuthHash(): string { return createHash('sha256').update(configuration.cliApiToken).digest('hex'); }

export function codexHome(): string {
    const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    try { return realpathSync(home); } catch { return home; }
}

export function runtimeAlive(record: CodexRuntimeRecord): boolean {
    return isProcessAlive(record.pid) && getProcessStartMarker(record.pid) === record.marker;
}

function generationMayBeAlive(pid: number, marker?: string, snapshot?: ReadonlyMap<number, string | null> | WindowsProcessTable | null): boolean {
    if (snapshot !== undefined) {
        if (snapshot === null) return true;
        if (!snapshot.has(pid)) return false;
        const entry = snapshot.get(pid);
        const actual = typeof entry === 'object' && entry !== null ? entry.marker : entry;
        return !actual || !marker || actual === marker;
    }
    if (!isProcessAlive(pid)) return false;
    const actual = getProcessStartMarker(pid);
    // A failed OS probe is not evidence that the engine exited.
    return !actual || !marker || actual === marker;
}
export function runtimeMayBeAlive(owner: CodexRuntimeRecord, snapshot?: ReadonlyMap<number, string | null> | WindowsProcessTable | null): boolean {
    return generationMayBeAlive(owner.pid, owner.marker, snapshot)
        || Boolean(owner.kind !== 'attached' && owner.serverPid && generationMayBeAlive(owner.serverPid, owner.serverMarker, snapshot));
}

export async function readRuntimes(options?: { strict?: boolean }): Promise<CodexRuntimeRecord[]> {
    return readRecords(runtimeDirectory(), options?.strict === true);
}
async function readRecords(directory: string, strict = false): Promise<CodexRuntimeRecord[]> {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (strict && error.code !== 'ENOENT') throw error;
        return [] as string[];
    });
    const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
        try { return RuntimeSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8'))); }
        catch (error) {
            if (strict) throw new Error(`Cannot verify Codex ownership record ${join(directory, name)}. Inspect it and its processes before recovery.`, { cause: error });
            return null;
        }
    }));
    return records.filter((record): record is CodexRuntimeRecord => record !== null);
}

export async function saveRuntime(record: CodexRuntimeRecord): Promise<void> {
    // Ownership follows the native store, even when two launches use different
    // HAPI_HOME / hub namespaces. These are files, not a global agent daemon.
    for (const directory of [join(record.codexHome, 'hapi-runtime-owners'), runtimeDirectory()]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const target = join(directory, `${record.id}.json`);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, target);
    }
}

/** The store-wide lock spans cold resume, not merely registry writes. */
export async function withThreadOwnership<T>(home: string, threadId: string, ownId: string, work: () => Promise<T>,
    onPreflightRejected?: (error: unknown) => Promise<T>, intent: 'owned' | 'attached' = 'owned'): Promise<T> {
    const directory = join(home, 'hapi-runtime-owners');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withSettingsFileLock(join(directory, 'ownership'), async () => {
        try {
            const owners = (await readRecords(directory, true)).filter(owner => owner.id !== ownId && owner.codexHome === home);
            // Read records first under the ownership lock, then take a fresh OS
            // snapshot. Old generations must not cost one synchronous probe each.
            const snapshot = isWindows() && owners.some(owner => owner.pendingCreations?.length
                || Object.values(owner.sessions).some(session => session.threadId === threadId && session.active))
                ? readOwnershipProcessSnapshot() : undefined;
            const mayBeAlive = (pid: number, marker?: string) => snapshot
                ? snapshotGenerationMayBeAlive(snapshot, pid, marker) : generationMayBeAlive(pid, marker);
            for (const owner of owners) {
                if (owner.pendingCreations?.length && (mayBeAlive(owner.pid, owner.marker)
                    || Boolean(owner.serverPid && mayBeAlive(owner.serverPid, owner.serverMarker)))) {
                    throw new Error(`Codex runtime ${owner.id} has an unconfirmed creation. Inspect/stop that runtime before cold resume; its thread ID may be unknown.`);
                }
                const match = Object.entries(owner.sessions).find(([, session]) => session.threadId === threadId
                    && (session.active || owner.kind === 'attached' || intent === 'attached'));
                if (!match) continue;
                if (owner.kind === 'attached' && intent === 'owned') {
                    throw new Error('Externally attached thread: use hapi attach, never cold-resume it into an owned runtime');
                }
                if (owner.kind !== 'attached' && intent === 'attached') {
                    throw new Error('Thread has an owned HAPI binding. Fork it in the external desktop before attaching; no automatic migration.');
                }
                if (!match[1].active) continue;
                const orphanAlive = owner.serverPid && mayBeAlive(owner.serverPid, owner.serverMarker);
                const wrapperAlive = mayBeAlive(owner.pid, owner.marker);
                if (wrapperAlive || orphanAlive) {
                    throw new Error(`Thread belongs to another Codex runtime. Use hapi resume ${match[0]}.${orphanAlive && !wrapperAlive ? ' Its wrapper exited; stop the orphaned runtime before recovery.' : ''}`);
                }
            }
        } catch (error) {
            // Still under the store lock, before work can mutate native state.
            // Recovery callers can inspect their journal without racing a writer.
            if (onPreflightRejected) return onPreflightRejected(error);
            throw error;
        }
        return work();
    });
}

export async function findRuntime(sessionId: string): Promise<CodexRuntimeRecord | undefined> {
    return (await readRuntimes()).find(record => record.hub === configuration.apiUrl && record.authHash === runtimeAuthHash()
        && record.sessions[sessionId]?.active && runtimeAlive(record));
}

export async function findColdBinding(home: string, threadId: string): Promise<string | undefined> {
    for (const owner of await readRuntimes()) {
        if (owner.kind === 'attached') continue;
        if (owner.codexHome !== home || owner.hub !== configuration.apiUrl || owner.authHash !== runtimeAuthHash()) continue;
        const match = Object.entries(owner.sessions).find(([, session]) => session.threadId === threadId);
        if (match) return match[0];
    }
    return undefined;
}

export async function findAttachedBinding(home: string, threadId: string): Promise<string | undefined> {
    const owners = (await readRuntimes({ strict: true })).filter(owner => owner.kind === 'attached' && owner.codexHome === home
        && owner.hub === configuration.apiUrl && owner.authHash === runtimeAuthHash());
    const retired = new Set(owners.map(owner => owner.supersedes).filter(id => id !== undefined));
    for (const owner of owners) {
        const match = Object.entries(owner.sessions).find(([id, binding]) => binding.threadId === threadId && !retired.has(id));
        if (match) return match[0];
    }
    return undefined;
}
