import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { getProcessStartMarker, isProcessAlive } from '@/utils/process';
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock';

const RuntimeSchema = z.object({
    id: z.string(), pid: z.number().int().positive(), marker: z.string(),
    serverPid: z.number().int().positive().optional(), serverMarker: z.string().optional(),
    endpoint: z.string(), token: z.string().optional(),
    command: z.string(), args: z.array(z.string()), codexHome: z.string(), hub: z.string(), authHash: z.string(),
    pendingCreations: z.array(z.string()).optional(),
    sessions: z.record(z.string(), z.object({ threadId: z.string(), namespace: z.string(), active: z.boolean() }))
});
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

function generationMayBeAlive(pid: number, marker?: string): boolean {
    if (!isProcessAlive(pid)) return false;
    const actual = getProcessStartMarker(pid);
    // A failed OS probe is not evidence that the engine exited.
    return !actual || !marker || actual === marker;
}
export function runtimeMayBeAlive(owner: CodexRuntimeRecord): boolean {
    return generationMayBeAlive(owner.pid, owner.marker)
        || Boolean(owner.serverPid && generationMayBeAlive(owner.serverPid, owner.serverMarker));
}

export async function readRuntimes(): Promise<CodexRuntimeRecord[]> {
    return readRecords(runtimeDirectory());
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
export async function withThreadOwnership<T>(home: string, threadId: string, ownId: string, work: () => Promise<T>): Promise<T> {
    const directory = join(home, 'hapi-runtime-owners');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withSettingsFileLock(join(directory, 'ownership'), async () => {
        for (const owner of await readRecords(directory, true)) {
            if (owner.id === ownId || owner.codexHome !== home) continue;
            if (owner.pendingCreations?.length && runtimeMayBeAlive(owner)) {
                throw new Error(`Codex runtime ${owner.id} has an unconfirmed creation. Inspect/stop that runtime before cold resume; its thread ID may be unknown.`);
            }
            const match = Object.entries(owner.sessions).find(([, session]) => session.threadId === threadId && session.active);
            if (!match) continue;
            const orphanAlive = owner.serverPid && generationMayBeAlive(owner.serverPid, owner.serverMarker);
            if (generationMayBeAlive(owner.pid, owner.marker) || orphanAlive) {
                throw new Error(`Thread belongs to another Codex runtime. Use hapi resume ${match[0]}.${orphanAlive && !runtimeAlive(owner) ? ' Its wrapper exited; stop the orphaned runtime before recovery.' : ''}`);
            }
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
        if (owner.codexHome !== home || owner.hub !== configuration.apiUrl || owner.authHash !== runtimeAuthHash()) continue;
        const match = Object.entries(owner.sessions).find(([, session]) => session.threadId === threadId);
        if (match) return match[0];
    }
    return undefined;
}
