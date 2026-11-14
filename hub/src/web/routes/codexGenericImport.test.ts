import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import type { WebAppEnv } from '../middleware/auth'
import { createCodexDesktopRoutes, importSelectedCodexSessions, type CodexImportedMessageContent } from './codexDesktop'

/**
 * Pinning tests for the generic-route Codex import semantics: transcripts
 * always come from the runner's ListLocalSessions RPC (the hub never reads
 * its own CODEX_HOME), persistence is atomic, syncs serialize, a HAPI-side
 * rename and the runner machine host survive re-syncs, launch config goes
 * through applySessionConfig, and transcript list/sync work in every
 * namespace.
 */

const CODex_SESSION_ID = '17171717-1717-4717-8717-171717171717'

function codexUserMessage(text: string): CodexImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function codexAgentMessage(message: string, id = 'assistant-1'): CodexImportedMessageContent {
    return {
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message, id } },
        meta: { sentFrom: 'cli' }
    }
}

function codexThreadFixture(id: string, messages: CodexImportedMessageContent[], overrides: {
    title?: string
    cwd?: string
} = {}) {
    return {
        id,
        title: overrides.title ?? `Codex thread ${id}`,
        cwd: overrides.cwd ?? 'C:\\work\\project',
        file: `rollout-${id}.jsonl`,
        modifiedAt: 1,
        messages
    }
}

function createImportSyncEngine(store: Store, machines: Machine[]): SyncEngine {
    return {
        getOnlineMachinesByNamespace: (namespace: string) => machines.filter((candidate) => (
            candidate.namespace === namespace && candidate.active
        )),
        getSessionsByNamespace: (namespace: string) => (
            store.sessions.getSessionsByNamespace(namespace) as unknown as ReturnType<SyncEngine['getSessionsByNamespace']>
        ),
        getOrCreateSession: (
            tag: string,
            metadata: unknown,
            agentState: unknown,
            namespace: string
        ) => (
            store.sessions.getOrCreateSession(tag, metadata, agentState, namespace) as unknown as ReturnType<SyncEngine['getOrCreateSession']>
        ),
        handleRealtimeEvent: () => {},
        recordSessionActivity: () => {}
    } as unknown as SyncEngine
}

function machine(id: string, workspaceRoots: string[] = [], capabilities?: string[]): Machine {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: `${id}.host`,
            platform: 'linux',
            happyCliVersion: '0.0.0-test',
            workspaceRoots,
            ...(capabilities ? { capabilities } : {})
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function standardTranscriptFixture() {
    return codexThreadFixture(CODex_SESSION_ID, [
        codexUserMessage('normal user message'),
        codexAgentMessage('normal assistant message')
    ])
}

/** Legacy ListCodexSessions stub serving the given raw rows. */
function serveLegacyCodexSessions(engine: SyncEngine, sessions: unknown[]): void {
    ;(engine as unknown as Record<string, unknown>).listCodexSessionsForMachine = async () => ({
        success: true,
        sessions
    })
}

/** Normalized ListLocalSessions transcript for the standard fixture. */
function fixtureTranscript(): LocalTranscript {
    const fixture = standardTranscriptFixture()
    return {
        flavor: 'codex',
        id: fixture.id,
        title: fixture.title,
        lastUserMessage: 'normal user message',
        cwd: fixture.cwd,
        file: fixture.file,
        modifiedAt: fixture.modifiedAt,
        extra: { originator: 'codex-cli', cliVersion: '9.9.9', source: null, threadSource: null, forkedFromId: null },
        messages: fixture.messages.map((content, index) => ({
            id: `codex-desktop:${fixture.id}:${index}`,
            content
        }))
    }
}

/** Normalized ListLocalSessions summary (no messages) for list calls. */
function fixtureSummary(): LocalTranscript {
    const { messages: _messages, ...summary } = fixtureTranscript()
    return summary as LocalTranscript
}

function harnessApp(store: Store, engine: SyncEngine) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))
    return app
}

describe('Codex generic import', () => {
    const stores: Store[] = []
    const originalCodexHome = process.env.CODEX_HOME

    afterEach(() => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }
        for (const store of stores.splice(0)) store.close()
    })

    it('never reads the hub\'s own CODEX_HOME', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-x1-hub-disk-'))
        process.env.CODEX_HOME = codexHome
        // A transcript exists on the hub's own disk; without runner sessions
        // the import must fail instead of reading it.
        const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
        mkdirSync(sessionDir, { recursive: true })
        writeFileSync(join(sessionDir, `rollout-${CODex_SESSION_ID}.jsonl`), '{}\n', 'utf-8')
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1')])
        serveLegacyCodexSessions(engine, [])

        const result = await importSelectedCodexSessions({
            codexSessionIds: [CODex_SESSION_ID],
            store,
            namespace: 'default',
            getSyncEngine: () => engine
        })

        expect(result.success).toBe(false)
        if (result.success) throw new Error('Expected the hub-disk fallback to be gone')
        expect(result.error).toContain('Transcript not found for Codex session')
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
        rmSync(codexHome, { recursive: true, force: true })
    })

    it('rolls a Codex sync back on insert failure', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1')])
        serveLegacyCodexSessions(engine, [codexThreadFixture(CODex_SESSION_ID, [
            codexUserMessage('one'),
            codexUserMessage('two')
        ])])
        const original = store.messages.addImportedMessage.bind(store.messages)
        let calls = 0
        ;(store.messages as { addImportedMessage: typeof original }).addImportedMessage = (
            (sessionId: string, content: unknown, localId: string, createdAt: number) => {
                calls += 1
                if (calls === 2) throw new Error('boom')
                return original(sessionId, content, localId, createdAt)
            }
        ) as typeof original

        const result = await importSelectedCodexSessions({
            codexSessionIds: [CODex_SESSION_ID],
            store,
            namespace: 'default',
            getSyncEngine: () => engine
        })

        expect(result.success).toBe(false)
        if (result.success) throw new Error('Expected the failed sync to report an error')
        expect(result.error).toContain('boom')
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('serializes concurrent syncs of one Codex thread', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1')])
        const legacySessions: unknown[] = [standardTranscriptFixture()]
        serveLegacyCodexSessions(engine, legacySessions)
        const fixture = standardTranscriptFixture()

        const [first, second] = await Promise.all([
            importSelectedCodexSessions({
                codexSessionIds: [CODex_SESSION_ID],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            }),
            importSelectedCodexSessions({
                codexSessionIds: [CODex_SESSION_ID],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })
        ])

        expect(first.success).toBe(true)
        expect(second.success).toBe(true)
        const codexSessions = store.sessions.getSessionsByNamespace('default')
        expect(codexSessions).toHaveLength(1)
        expect(store.messages.getAllMessages(codexSessions[0]!.id)).toHaveLength(2)
        const firstOutput = first.success ? first.output : ''
        const secondOutput = second.success ? second.output : ''
        expect(firstOutput).toContain('Action: created')
        expect(secondOutput).toContain('Action: updated')
        expect(secondOutput).toContain('Appended messages: 0')
    })

    it('preserves a renamed HAPI Codex session on re-sync and records the runner machine host', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1')])
        const legacySessions: unknown[] = [standardTranscriptFixture()]
        serveLegacyCodexSessions(engine, legacySessions)
        const fixture = standardTranscriptFixture()

        const first = await importSelectedCodexSessions({
            codexSessionIds: [CODex_SESSION_ID],
            store,
            namespace: 'default',
            getSyncEngine: () => engine
        })
        expect(first.success).toBe(true)
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        expect(session.metadata).toMatchObject({ host: 'm-1.host', machineId: 'm-1' })
        store.sessions.updateSessionMetadata(session.id, {
            ...(session.metadata as Record<string, unknown>),
            name: 'My custom HAPI title'
        }, session.metadataVersion, 'default')

        legacySessions[0] = codexThreadFixture(CODex_SESSION_ID, [
            codexUserMessage('normal user message'),
            codexAgentMessage('normal assistant message'),
            codexUserMessage('a later turn')
        ])

        const second = await importSelectedCodexSessions({
            codexSessionIds: [CODex_SESSION_ID],
            store,
            namespace: 'default',
            getSyncEngine: () => engine
        })

        expect(second.success).toBe(true)
        const renamed = store.sessions.getSessionsByNamespace('default')[0]!
        expect(renamed.id).toBe(session.id)
        expect((renamed.metadata as Record<string, unknown>).name).toBe('My custom HAPI title')
        expect(store.messages.getAllMessages(session.id)).toHaveLength(3)
    })

    it('applies model and effort through session config', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1')])
        serveLegacyCodexSessions(engine, [standardTranscriptFixture()])
        const applied: Array<{ sessionId: string; config: unknown }> = []
        ;(engine as unknown as { applySessionConfig: (sessionId: string, config: unknown) => Promise<void> }).applySessionConfig = async (sessionId, config) => {
            applied.push({ sessionId, config })
        }

        const result = await importSelectedCodexSessions({
            codexSessionIds: [CODex_SESSION_ID],
            store,
            namespace: 'default',
            getSyncEngine: () => engine,
            model: 'gpt-5.6',
            modelReasoningEffort: 'high'
        })

        expect(result.success).toBe(true)
        const importedSessionId = result.success ? result.hapiSessionIds?.[0] : undefined
        expect(importedSessionId).toBeDefined()
        expect(applied).toEqual([{
            sessionId: importedSessionId!,
            config: { model: 'gpt-5.6', modelReasoningEffort: 'high' }
        }])
    })

    it('allows Codex history import in a non-default namespace', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const machineA = { ...machine('m-1'), namespace: 'team-a' }
        const engine = createImportSyncEngine(store, [machineA])
        const listCalls: string[] = []
        ;(engine as unknown as { listCodexSessionsForMachine: unknown }).listCodexSessionsForMachine = async (calledMachineId: string, _cwd: unknown, sessionIds?: string[] | null) => {
            listCalls.push(calledMachineId)
            // The legacy list RPC answers summaries without ids and full
            // transcripts for exactly the requested ids.
            return sessionIds?.length
                ? { success: true, sessions: [standardTranscriptFixture()] }
                : { success: true, sessions: [{ ...standardTranscriptFixture(), messages: undefined, originator: 'codex-cli', cliVersion: '9.9.9' }] }
        }
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'team-a')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        const listResponse = await app.request('/api/codex/sessions')
        expect(listResponse.status).toBe(200)
        const listBody = await listResponse.json() as { success: boolean; sessions: unknown[] }
        expect(listBody.success).toBe(true)
        expect(listBody.sessions).toHaveLength(1)

        const syncResponse = await app.request('/api/codex/sync-session', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: [CODex_SESSION_ID] })
        })
        const syncBody = await syncResponse.json() as { success: boolean }
        expect(syncBody.success).toBe(true)
        // One list fetch for GET /codex/sessions and one for the sync.
        expect(listCalls).toEqual(['m-1', 'm-1'])
        expect(store.sessions.getSessionsByNamespace('team-a')).toHaveLength(1)
    })

    it('lists and imports through ListLocalSessions when the runner advertises the capability', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1', [], ['local-session-import'])])
        let legacyCalls = 0
        ;(engine as unknown as Record<string, unknown>).listCodexSessionsForMachine = async () => {
            legacyCalls += 1
            return { success: true, sessions: [] }
        }
        const listCalls: Array<{ machineId: string; payload: unknown }> = []
        ;(engine as unknown as Record<string, unknown>).listLocalSessionsForMachine = async (calledMachineId: string, payload: { sessionIds?: string[] | null }) => {
            listCalls.push({ machineId: calledMachineId, payload })
            return { success: true, sessions: payload.sessionIds ? [fixtureTranscript()] : [fixtureSummary()] }
        }

        const app = harnessApp(store, engine)
        const listResponse = await app.request('/api/codex/sessions')
        expect(listResponse.status).toBe(200)
        const listBody = await listResponse.json() as { success: boolean; sessions: Array<Record<string, unknown>> }
        expect(listBody.success).toBe(true)
        expect(listBody.sessions).toHaveLength(1)
        // The web shape flattens the normalized summary's extra fields.
        expect(listBody.sessions[0]).toMatchObject({ id: CODex_SESSION_ID, originator: 'codex-cli', cliVersion: '9.9.9' })
        expect(Object.keys(listBody.sessions[0]!)).not.toContain('flavor')
        expect(Object.keys(listBody.sessions[0]!)).not.toContain('launch')

        const syncResponse = await app.request('/api/codex/sync-session', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: [CODex_SESSION_ID] })
        })
        const syncBody = await syncResponse.json() as { success: boolean }
        expect(syncBody.success).toBe(true)
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        expect(legacyCalls).toBe(0)
        expect(listCalls.map((call) => call.payload)).toEqual([
            { flavor: 'codex', cwd: null, sessionIds: null },
            { flavor: 'codex', cwd: null, sessionIds: [CODex_SESSION_ID] }
        ])
    })

    it('caps sync-session imports at the shared 200-session limit', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = createImportSyncEngine(store, [machine('m-1')])
        serveLegacyCodexSessions(engine, [])
        const app = harnessApp(store, engine)

        const response = await app.request('/api/codex/sync-session', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `thread-${index}`) })
        })
        expect(response.status).toBe(400)
        const body = await response.json() as { success: boolean; error?: string }
        expect(body.success).toBe(false)
        expect(body.error).toContain('200')
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })
})