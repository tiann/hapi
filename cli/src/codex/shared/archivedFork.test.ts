import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApiClient } from '@/api/api'
import { CodexAppServerClient } from '../codexAppServerClient'
import { codexHome } from './registry'
import { forkArchivedCodex, performArchivedFork, type ArchivedForkJournal } from './archivedFork'
import type { ForkArchivedCodexRequest } from '@hapi/protocol/apiTypes'

vi.mock('@/utils/process', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/process')>(),
    // Ownership must conservatively retain a live PID with an unknown marker;
    // the OS-specific marker probe is covered separately from this journal test.
    getProcessStartMarker: () => undefined,
    isProcessAlive: (pid: number) => pid === process.pid
}))

function fixture() {
    const request: ForkArchivedCodexRequest = { operationId: 'operation', sourceSessionId: 'hapi-source', sourceThreadId: 'source', directory: '/work',
        boundary: { localId: 'second', turnId: 'turn-2' } }
    const journal: ArchivedForkJournal = { request: structuredClone(request), restoreRequired: false, forkIssued: false, done: false }
    let archived = true
    const source = { id: 'source', cwd: '/work', status: { type: 'notLoaded' }, turns: [
        { id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', clientId: 'first' }] },
        { id: 'turn-2', status: 'interrupted', items: [{ type: 'userMessage', clientId: 'second' }] }
    ] }
    const calls: string[] = []
    const native = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
        const p = params as Record<string, unknown>
        calls.push(`${method}:${p?.threadId ?? ''}`)
        if (method === 'thread/read') return { thread: source }
        if (method === 'thread/loaded/list') { expect(params).toEqual({}); return { data: [] } }
        if (method === 'thread/unarchive') { archived = false; return {} }
        if (method === 'thread/archive') { if (p.threadId === 'source') archived = true; return {} }
        if (method === 'thread/fork') {
            if (archived) throw new Error('session source is archived. Run `codex unarchive source` to unarchive it first.')
            return { thread: { id: 'child', forkedFromId: 'source', parentThreadId: null } }
        }
        throw new Error(`Unexpected method ${method}`)
    })
    const client = { request: native } as unknown as Parameters<typeof performArchivedFork>[0]
    const snapshots: ArchivedForkJournal[] = []
    const save = vi.fn(async () => { snapshots.push(structuredClone(journal)) })
    const inactive = vi.fn(async () => {})
    return { request, journal, client, native, source, calls, save, snapshots, inactive, archived: () => archived,
        run: () => performArchivedFork(client, request, journal, save, inactive) }
}

describe('archived Codex native fork', () => {
    it('unarchives, forks at the exact boundary, restores source, and releases the child writer', async () => {
        const f = fixture()
        await expect(f.run()).resolves.toBe('child')
        expect(f.archived()).toBe(true)
        expect(f.calls).toEqual(['thread/read:source', 'thread/read:source', 'thread/fork:source', 'thread/unarchive:source',
            'thread/fork:source', 'thread/loaded/list:', 'thread/archive:source', 'thread/archive:child'])
        expect(f.native).toHaveBeenCalledWith('thread/fork', { threadId: 'source', beforeTurnId: 'turn-2', deferGoalContinuation: true, excludeTurns: true })
        expect(f.snapshots.some(snapshot => snapshot.restoreRequired && !snapshot.forkIssued)).toBe(true)
        expect(f.journal).toMatchObject({ nativeSessionId: 'child', restoreRequired: false, done: true })
        const count = f.native.mock.calls.length
        await expect(f.run()).resolves.toBe('child')
        expect(f.native).toHaveBeenCalledTimes(count)
    })

    it('restores a source even when the second fork fails; never replays an unconfirmed mutation', async () => {
        const f = fixture()
        const original = f.native.getMockImplementation()!
        f.native.mockImplementation(async (method, params) => {
            if (method === 'thread/fork' && !f.archived()) throw new Error('transport lost')
            return original(method, params)
        })
        await expect(f.run()).rejects.toThrow('transport lost')
        expect(f.archived()).toBe(true)
        await expect(f.run()).rejects.toThrow('unconfirmed')
        expect(f.native.mock.calls.filter(([method]) => method === 'thread/fork')).toHaveLength(2)
    })

    it('reconciles a persisted restore intent and known child without another fork', async () => {
        const f = fixture()
        Object.assign(f.journal, { restoreRequired: true, forkIssued: true, nativeSessionId: 'child' })
        await expect(f.run()).resolves.toBe('child')
        expect(f.calls).toEqual(['thread/loaded/list:', 'thread/archive:source', 'thread/archive:child'])
    })

    it('retains recovery intent when restoring the source fails', async () => {
        const f = fixture()
        const original = f.native.getMockImplementation()!
        f.native.mockImplementation(async (method, params) => {
            if (method === 'thread/archive' && (params as { threadId: string }).threadId === 'source') throw new Error('archive unavailable')
            return original(method, params)
        })
        await expect(f.run()).rejects.toThrow('archive unavailable')
        expect(f.journal).toMatchObject({ restoreRequired: true, nativeSessionId: 'child', done: false })
        f.native.mockImplementation(original)
        await expect(f.run()).resolves.toBe('child')
        expect(f.native.mock.calls.filter(([method]) => method === 'thread/fork')).toHaveLength(2)
    })

    it.each(['loaded', 'boundary', 'cwd', 'identity', 'unfinished', 'steered'])('rejects an unsafe %s source before native mutation', async kind => {
        const f = fixture()
        if (kind === 'loaded') f.source.status.type = 'idle'
        if (kind === 'boundary') f.request.boundary!.turnId = 'missing'
        if (kind === 'cwd') f.source.cwd = '/another'
        if (kind === 'identity') f.source.id = 'another'
        if (kind === 'unfinished') f.source.turns[1].status = 'inProgress'
        if (kind === 'steered') f.request.boundary!.localId = 'not-first'
        f.journal.request = structuredClone(f.request)
        await expect(f.run()).rejects.toThrow()
        expect(f.native.mock.calls.some(([method]) => ['thread/fork', 'thread/unarchive'].includes(method))).toBe(false)
    })

    it('refuses to restore over a newly loaded source', async () => {
        const f = fixture()
        f.journal.restoreRequired = true
        f.native.mockResolvedValue({ data: ['source'] })
        await expect(f.run()).rejects.toThrow('potentially active')
        expect(f.journal.restoreRequired).toBe(true)
        expect(f.calls).toEqual([])
    })

    it('stops before any native call when HAPI source was reopened', async () => {
        const f = fixture()
        f.inactive.mockRejectedValue(new Error('Source session changed'))
        await expect(f.run()).rejects.toThrow('Source session changed')
        expect(f.native).not.toHaveBeenCalled()
    })
})

describe('archived fork workspace preflight', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

    it.each(['fresh', 'restore', 'unconfirmed', 'known-child'].flatMap(kind => ['policy', 'ownership'].map(preflight => ({ kind, preflight }))))('rejects $preflight preflight for a $kind operation and preserves recovery intent', async ({ kind, preflight }) => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-archived-preflight-'))
        vi.stubEnv('CODEX_HOME', home)
        vi.spyOn(ApiClient, 'create').mockResolvedValue({} as ApiClient)
        const connect = vi.spyOn(CodexAppServerClient.prototype, 'connect').mockRejectedValue(new Error('unexpected native startup'))
        const request = fixture().request
        const target = join(home, 'hapi-archived-forks', `${request.operationId}.json`)
        const journal: ArchivedForkJournal = { request, restoreRequired: kind === 'restore',
            forkIssued: kind === 'unconfirmed' || kind === 'known-child', done: false,
            ...(kind === 'known-child' ? { nativeSessionId: 'child' } : {}) }
        try {
            if (preflight === 'ownership') {
                const owners = join(home, 'hapi-runtime-owners')
                await mkdir(owners, { recursive: true })
                await writeFile(join(owners, 'live.json'), JSON.stringify({ id: 'other', pid: process.pid, marker: '',
                    endpoint: 'mock', command: 'codex', args: [], codexHome: codexHome(), hub: 'hub', authHash: 'hash',
                    sessions: { source: { threadId: request.sourceThreadId, namespace: 'ns', active: true } } }))
            }
            if (kind !== 'fresh') {
                await mkdir(join(home, 'hapi-archived-forks'), { recursive: true })
                await writeFile(target, JSON.stringify(journal))
            }
            expect(await forkArchivedCodex(request, async () => preflight !== 'policy')).toEqual({
                error: preflight === 'policy' ? 'Directory is outside workspace roots'
                    : 'Thread belongs to another Codex runtime. Use hapi resume source.', rollbackSafe: kind === 'fresh'
            })
            expect(connect).not.toHaveBeenCalled()
            if (kind !== 'fresh') expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(journal)
        } finally { await rm(home, { recursive: true, force: true }) }
    })
})
