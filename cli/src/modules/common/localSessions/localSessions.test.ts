import { beforeEach, describe, expect, it } from 'vitest'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import { clearLocalSessionSources, getLocalSessionSource, listLocalSessionFlavors, registerLocalSessionSource } from './registry'
import { registerLocalSessionHandlers } from './rpcHandlers'
import type { CliLocalSessionSource, LocalSessionHandlerDeps } from './types'

const transcript: LocalTranscript = {
    flavor: 'pi',
    id: 'pi-1',
    title: 'Pi session',
    cwd: '/tmp/project',
    file: '/tmp/pi-1.jsonl',
    modifiedAt: 1,
    messages: []
}

function source(flavor: CliLocalSessionSource['flavor'], items: LocalTranscript[] = [transcript]): CliLocalSessionSource {
    return {
        flavor,
        list: (params) => params.sessionIds
            ? items.filter((item) => params.sessionIds!.includes(item.id)).map((item) => ({ ...item, messages: [] }))
            : items
    }
}

function deps(overrides: Partial<LocalSessionHandlerDeps> = {}): LocalSessionHandlerDeps & { calls: unknown[] } {
    const calls: unknown[] = []
    return {
        calls,
        registerHandler: (method, handler) => calls.push({ method, handler }),
        resolveForCheck: async (path) => path,
        isWithinSpawnRoots: () => true,
        isSessionWithinWorkspaceRoots: async () => true,
        ...overrides
    }
}

describe('local session registry', () => {
    beforeEach(() => {
        clearLocalSessionSources()
    })

    it('stores one source per flavor and reports registered flavors', () => {
        registerLocalSessionSource(source('pi'))
        registerLocalSessionSource(source('pi'))
        registerLocalSessionSource(source('opencode'))
        expect(getLocalSessionSource('pi')?.flavor).toBe('pi')
        expect(getLocalSessionSource('claude')).toBeNull()
        expect(listLocalSessionFlavors()).toEqual(['pi', 'opencode'])
    })
})

describe('ListLocalSessions RPC handler', () => {
    beforeEach(() => {
        clearLocalSessionSources()
    })

    function handlerResult(depsOverrides: Partial<LocalSessionHandlerDeps> = {}, params: unknown) {
        const harness = deps(depsOverrides)
        registerLocalSessionHandlers(harness)
        const registered = harness.calls[0] as { method: string; handler: (params: unknown) => Promise<unknown> }
        return { harness, response: registered.handler(params) as Promise<{ success: boolean; error?: string; sessions?: unknown[] }> }
    }

    it('returns summaries when no ids are requested and filters by workspace roots', async () => {
        registerLocalSessionSource(source('pi', [transcript, { ...transcript, id: 'pi-2', cwd: '/outside' }]))
        const { response } = handlerResult({
            isSessionWithinWorkspaceRoots: async (session) => session.cwd !== '/outside'
        }, { flavor: 'pi' })
        const result = await response
        expect(result.success).toBe(true)
        expect(result.sessions?.map((session) => (session as LocalTranscript).id)).toEqual(['pi-1'])
    })

    it('returns transcripts for requested ids', async () => {
        registerLocalSessionSource(source('pi', [transcript, { ...transcript, id: 'pi-2' }]))
        const { response } = handlerResult({}, { flavor: 'pi', sessionIds: ['pi-2'] })
        const result = await response
        expect(result.success).toBe(true)
        expect(result.sessions?.length).toBe(1)
        expect((result.sessions?.[0] as LocalTranscript).messages).toEqual([])
    })

    it('rejects a cwd outside the workspace roots before reading the disk', async () => {
        registerLocalSessionSource(source('pi'))
        const { response } = handlerResult({
            isWithinSpawnRoots: () => false
        }, { flavor: 'pi', cwd: '/etc' })
        const result = await response
        expect(result.success).toBe(false)
        expect(result.error).toBe('Path is outside workspace roots')
    })

    it('fails closed for unknown flavors and malformed requests', async () => {
        const missing = await (await handlerResult({}, { flavor: 'codex' })).response
        expect(missing.success).toBe(false)

        const malformed = await (await handlerResult({}, { flavor: 'nope' })).response
        expect(malformed.success).toBe(false)
        expect(malformed.error).toBe('Invalid local sessions request')
    })

    it('registers exactly one RPC method', () => {
        const { harness } = { harness: (() => {
            const h = deps()
            registerLocalSessionHandlers(h)
            return h
        })() }
        expect(harness.calls).toHaveLength(1)
        expect((harness.calls[0] as { method: string }).method).toBe('listLocalSessions')
    })
})