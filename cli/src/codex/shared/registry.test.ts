import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ home: '', auth: 'token', processes: new Map<number, string | undefined>() }));
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'hub', get cliApiToken() { return state.auth; } } }));
vi.mock('@/utils/process', () => ({ isProcessAlive: (pid: number) => state.processes.has(pid), getProcessStartMarker: (pid: number) => state.processes.get(pid) }));
import { findRuntime, runtimeAlive, runtimeAuthHash, runtimeMayBeAlive, saveRuntime, withThreadOwnership, type CodexRuntimeRecord } from './registry';

const directories: string[] = [];
afterEach(async () => { state.processes.clear(); state.auth = 'token'; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<CodexRuntimeRecord> {
    const home = await mkdtemp(join(tmpdir(), 'hapi-owner-')); directories.push(home); state.home = join(home, 'hapi');
    return { id: 'owner', pid: 1111, marker: 'worker-start', serverPid: 2222, serverMarker: 'server-start', command: 'codex', args: [],
        codexHome: join(home, 'codex'), endpoint: 'unix://private', hub: 'hub', authHash: runtimeAuthHash(),
        sessions: { sid: { threadId: 'thread', namespace: 'ns', active: true } } };
}
describe('shared runtime ownership', () => {
    it('distinguishes PID reuse from an unknown generation and a live orphan engine', async () => {
        const owner = await fixture(); state.processes.set(1111, 'different-start');
        expect(runtimeAlive(owner)).toBe(false); expect(runtimeMayBeAlive(owner)).toBe(false);
        state.processes.set(1111, undefined); expect(runtimeMayBeAlive(owner)).toBe(true);
        state.processes.delete(1111); state.processes.set(2222, 'server-start'); expect(runtimeMayBeAlive(owner)).toBe(true);
        await saveRuntime(owner);
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('orphaned');
    });
    it('protects one native store even across HAPI homes and scopes attach by authentication', async () => {
        const owner = await fixture(); state.processes.set(1111, owner.marker); await saveRuntime(owner);
        expect(await findRuntime('sid')).toMatchObject({ id: owner.id });
        state.auth = 'other'; expect(await findRuntime('sid')).toBeUndefined();
        state.home = join(directories[0], 'different-hapi');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('hapi resume sid');
        state.processes.clear(); expect(await withThreadOwnership(owner.codexHome, 'thread', 'new', async () => 'safe')).toBe('safe');
    });
    it('fails closed on corrupt records and unknown thread IDs after a creation timeout', async () => {
        const owner = await fixture(); owner.pendingCreations = ['unbound']; state.processes.set(1111, owner.marker); await saveRuntime(owner);
        await expect(withThreadOwnership(owner.codexHome, 'unknown-thread', 'new', async () => {})).rejects.toThrow('unconfirmed creation');
        const directory = join(owner.codexHome, 'hapi-runtime-owners'); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'broken.json'), '{');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('Cannot verify');
    });
});
