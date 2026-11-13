import { afterEach, describe, expect, it } from 'bun:test'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import { Store } from '../../../store'
import { OPENCODE_LOCAL_SESSION_SOURCE, PI_LOCAL_SESSION_SOURCE, CODEX_LOCAL_SESSION_SOURCE } from './sources'
import { importLocalTranscript } from './importLocalTranscript'

function machine(id = 'm-1'): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'darwin', happyCliVersion: 'test', workspaceRoots: ['/tmp/project'] },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userContent(text: string) {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const
}

function agentContent(id: string, message: string) {
    return {
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message, id } },
        meta: { sentFrom: 'cli' }
    } as const
}

function opencodeTranscript(id: string, texts: string[]): LocalTranscript {
    return {
        flavor: 'opencode',
        id,
        title: `OpenCode ${id}`,
        lastUserMessage: texts.at(-1) ?? null,
        cwd: '/tmp/project',
        file: '/tmp/opencode.db',
        modifiedAt: 1_000,
        messages: texts.map((text, index) => ({
            id: `opencode:${id}:msg-${index}:part-1`,
            createdAt: 1_100 + index,
            content: index % 2 === 0 ? userContent(text) : agentContent(`part-${index}`, text)
        }))
    }
}

function codexTranscript(id: string, contents: unknown[]): LocalTranscript {
    return {
        flavor: 'codex',
        id,
        title: `Codex ${id}`,
        lastUserMessage: 'run the tests',
        cwd: '/tmp/project',
        file: '/tmp/thread.jsonl',
        modifiedAt: 1_000,
        messages: contents.map((content, index) => ({
            id: `codex-desktop:${id}:${index}`,
            content: content as LocalTranscript['messages'][number]['content']
        }))
    }
}

function harness() {
    const store = new Store(':memory:')
    const events: unknown[] = []
    const appliedConfigs: Array<Record<string, unknown>> = []
    const engine = {
        recordSessionActivity: (sessionId: string, updatedAt: number) => {
            store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
        },
        handleRealtimeEvent: (event: unknown) => events.push(event),
        applySessionConfig: async (_sessionId: string, config: Record<string, unknown>) => {
            appliedConfigs.push(config)
        },
        getSessionsByNamespace: () => [],
        getOnlineMachinesByNamespace: () => [machine()]
    } as unknown as SyncEngine
    return { store, engine, events, appliedConfigs }
}

describe('generic local import', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('creates a session with lifecycle metadata and appends the transcript', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const outcome = await importLocalTranscript({
            store,
            engine,
            namespace: 'default',
            source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['fix the bug', 'on it']),
            machine: machine()
        })
        expect(outcome).toMatchObject({ sessionId: 'ses-1', action: 'created', appended: 2 })
        const session = store.sessions.getSessionsByNamespace('default')
            .find((candidate) => candidate.metadata && (candidate.metadata as Record<string, unknown>).opencodeSessionId === 'ses-1')
        expect(session).toBeDefined()
        const metadata = session!.metadata as Record<string, unknown>
        expect(metadata).toMatchObject({
            flavor: 'opencode',
            opencodeSessionId: 'ses-1',
            machineId: 'm-1',
            host: 'm-1.local',
            os: 'darwin',
            lifecycleState: 'archived',
            archivedBy: 'opencode-import',
            archiveReason: 'Imported from local OpenCode history'
        })
        expect(store.messages.getAllMessages(session!.id)).toHaveLength(2)
    })

    it('is idempotent: the second import reports unchanged', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const transcript = opencodeTranscript('ses-1', ['fix the bug', 'on it'])
        const first = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE, transcript, machine: machine()
        })
        const second = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE, transcript, machine: machine()
        })
        expect(first.action).toBe('created')
        expect(second).toMatchObject({ action: 'unchanged', appended: 0 })
    })

    it('appends only the delta when the transcript grows', async () => {
        const { store, engine } = harness()
        stores.push(store)
        await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['fix the bug']), machine: machine()
        })
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['fix the bug', 'on it']), machine: machine()
        })
        expect(outcome).toMatchObject({ action: 'updated', appended: 1 })
    })

    it('rolls the whole import back when a message insert fails', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const transcript = opencodeTranscript('ses-1', ['one', 'two'])
        const original = store.messages.addImportedMessage.bind(store.messages)
        let calls = 0
        ;(store.messages as { addImportedMessage: typeof original }).addImportedMessage = (
            (sessionId: string, content: unknown, localId: string, createdAt: number) => {
                calls += 1
                if (calls === 2) throw new Error('boom')
                return original(sessionId, content, localId, createdAt)
            }
        ) as typeof original
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE, transcript, machine: machine()
        })
        expect(outcome.error).toMatchObject({ code: 'import_failed' })
        // The session creation rolled back with the failed insert.
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('rolls a failing append back for an existing session', async () => {
        const { store, engine } = harness()
        stores.push(store)
        await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['one']), machine: machine()
        })
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        const original = store.messages.addImportedMessage.bind(store.messages)
        let calls = 0
        ;(store.messages as { addImportedMessage: typeof original }).addImportedMessage = (
            (sessionId: string, content: unknown, localId: string, createdAt: number) => {
                calls += 1
                if (calls === 1) throw new Error('boom')
                return original(sessionId, content, localId, createdAt)
            }
        ) as typeof original
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['one', 'two']), machine: machine()
        })
        expect(outcome.error).toMatchObject({ code: 'import_failed' })
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
    })

    it('serializes concurrent imports of one contentPrefix thread', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const transcript = codexTranscript('thread-1', [userContent('hello'), agentContent('a', 'running')])
        const [first, second] = await Promise.all([
            importLocalTranscript({ store, engine, namespace: 'default', source: CODEX_LOCAL_SESSION_SOURCE, transcript, machine: machine() }),
            importLocalTranscript({ store, engine, namespace: 'default', source: CODEX_LOCAL_SESSION_SOURCE, transcript, machine: machine() })
        ])
        expect(first).toMatchObject({ action: 'created', appended: 2 })
        expect(second).toMatchObject({ action: 'unchanged', appended: 0 })
        const codexSessions = store.sessions.getSessionsByNamespace('default')
            .filter((candidate) => (candidate.metadata as Record<string, unknown>).flavor === 'codex')
        expect(codexSessions).toHaveLength(1)
        expect(codexSessions[0]!.tag).toBeTruthy()
    })

    it('stamps the codex lifecycle as imported and writes both id keys', async () => {
        const { store, engine } = harness()
        stores.push(store)
        await importLocalTranscript({
            store, engine, namespace: 'default', source: CODEX_LOCAL_SESSION_SOURCE,
            transcript: codexTranscript('thread-1', [userContent('hello')]), machine: machine()
        })
        const metadata = store.sessions.getSessionsByNamespace('default')[0]!.metadata as Record<string, unknown>
        expect(metadata).toMatchObject({
            flavor: 'codex',
            codexSessionId: 'thread-1',
            codexSourceSessionId: 'thread-1',
            lifecycleState: 'imported'
        })
        expect(metadata.archivedBy).toBeUndefined()
    })

    it('applies the five request launch keys through session config', async () => {
        const { store, engine, appliedConfigs } = harness()
        stores.push(store)
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['one']),
            machine: machine(),
            request: {
                launch: {
                    model: 'gpt-5.6',
                    modelReasoningEffort: 'high',
                    permissionMode: 'default',
                    serviceTier: 'fast',
                    collaborationMode: 'plan'
                }
            }
        })
        expect(outcome.error).toBeUndefined()
        expect(appliedConfigs).toEqual([{
            model: 'gpt-5.6',
            modelReasoningEffort: 'high',
            permissionMode: 'default',
            serviceTier: 'fast',
            collaborationMode: 'plan'
        }])
    })

    it('ignores a permission mode that the flavor does not allow', async () => {
        const { store, engine, appliedConfigs } = harness()
        stores.push(store)
        await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['one']),
            machine: machine(),
            request: { launch: { permissionMode: 'read-only' as never } }
        })
        expect(appliedConfigs).toEqual([])
    })

    it('applies transcript launch hints (Pi model and thinking level)', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const piTranscript: LocalTranscript = {
            flavor: 'pi',
            id: 'pi-1',
            title: 'Pi session',
            cwd: '/tmp/project',
            file: '/tmp/pi.jsonl',
            modifiedAt: 1,
            launch: { model: 'gemini-3.8-flash', effort: 'low' },
            messages: [
                { id: 'pi:pi-1:e1:user', createdAt: 1, content: userContent('hello'), anchor: 'e1', historyPoint: 'e1' }
            ],
            anchorOrder: ['e1'],
            cursor: 'e1'
        }
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: PI_LOCAL_SESSION_SOURCE, transcript: piTranscript, machine: machine()
        })
        expect(outcome.action).toBe('created')
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        expect(session.model).toBe('gemini-3.8-flash')
        expect(session.effort).toBe('low')
        const metadata = session.metadata as Record<string, unknown>
        expect(metadata.piHistoryLeafEntryId).toBe('e1')
        expect(metadata.conversationHistoryEntryIds).toMatchObject({ 'pi:pi-1:e1:user': 'e1' })
        expect((metadata.piImportState as Record<string, unknown>).state).toBe('complete')
    })

    it('marks a diverged import on the pi import state', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const base: LocalTranscript = {
            flavor: 'pi',
            id: 'pi-1',
            title: 'Pi session',
            cwd: '/tmp/project',
            file: '/tmp/pi.jsonl',
            modifiedAt: 1,
            messages: [
                { id: 'pi:pi-1:e1:user', createdAt: 1, content: userContent('one'), anchor: 'e1', historyPoint: 'e1' }
            ],
            anchorOrder: ['e1'],
            cursor: 'e1'
        }
        await importLocalTranscript({ store, engine, namespace: 'default', source: PI_LOCAL_SESSION_SOURCE, transcript: base, machine: machine() })
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        const changed: LocalTranscript = {
            ...base,
            messages: [{
                id: 'pi:pi-1:e1:user',
                createdAt: 1,
                content: userContent('rewritten'),
                anchor: 'e1',
                historyPoint: 'e1'
            }],
            cursor: 'e1'
        }
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: PI_LOCAL_SESSION_SOURCE, transcript: changed, machine: machine()
        })
        expect(outcome.error).toMatchObject({ code: 'transcript_diverged' })
        const metadata = store.sessions.getSessionByNamespace(session.id, 'default')!.metadata as Record<string, unknown>
        expect((metadata.piImportState as Record<string, unknown>).state).toBe('diverged')
    })

    it('does not reapply transcript launch hints over a HAPI-side model change on re-import', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const piTranscript: LocalTranscript = {
            flavor: 'pi',
            id: 'pi-hints',
            title: 'Pi hints session',
            cwd: '/tmp/project',
            file: '/tmp/pi-hints.jsonl',
            modifiedAt: 1,
            launch: { model: 'gemini-3.8-flash', effort: 'low' },
            messages: [
                { id: 'pi:pi-hints:e1:user', createdAt: 1, content: userContent('hello'), anchor: 'e1', historyPoint: 'e1' }
            ],
            anchorOrder: ['e1'],
            cursor: 'e1'
        }
        await importLocalTranscript({ store, engine, namespace: 'default', source: PI_LOCAL_SESSION_SOURCE, transcript: piTranscript, machine: machine() })
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        store.sessions.setSessionModel(session.id, 'user-choice', 'default', { touchUpdatedAt: false })

        const extended: LocalTranscript = {
            ...piTranscript,
            messages: [
                ...piTranscript.messages,
                { id: 'pi:pi-hints:e2:user', createdAt: 2, content: userContent('a later turn'), anchor: 'e2', historyPoint: 'e2' }
            ],
            anchorOrder: ['e1', 'e2'],
            cursor: 'e2'
        }
        const outcome = await importLocalTranscript({ store, engine, namespace: 'default', source: PI_LOCAL_SESSION_SOURCE, transcript: extended, machine: machine() })
        expect(outcome.action).toBe('updated')
        const updated = store.sessions.getSessionByNamespace(session.id, 'default')!
        expect(updated.model).toBe('user-choice')
    })

    it('stamps already_in_hapi as failed instead of diverged', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const created = store.sessions.getOrCreateSession('hapi-native-pi', {
            machineId: 'm-1',
            flavor: 'pi',
            piSessionId: 'pi-native'
        }, {}, 'default')
        store.messages.addImportedMessage(created.id, userContent('typed in HAPI'), 'local-1', 1)
        const transcript: LocalTranscript = {
            flavor: 'pi',
            id: 'pi-native',
            title: 'Pi native session',
            cwd: '/tmp/project',
            file: '/tmp/pi-native.jsonl',
            modifiedAt: 1,
            messages: [
                { id: 'pi:pi-native:e1:user', createdAt: 1, content: userContent('hello from pi'), anchor: 'e1', historyPoint: 'e1' },
                { id: 'pi:pi-native:e2:user', createdAt: 2, content: userContent('a newer turn'), anchor: 'e2', historyPoint: 'e2' }
            ],
            anchorOrder: ['e1', 'e2'],
            cursor: 'e2'
        }
        const outcome = await importLocalTranscript({ store, engine, namespace: 'default', source: PI_LOCAL_SESSION_SOURCE, transcript, machine: machine() })
        expect(outcome.error).toMatchObject({ code: 'already_in_hapi' })
        const metadata = store.sessions.getSessionByNamespace(created.id, 'default')!.metadata as Record<string, unknown>
        expect((metadata.piImportState as Record<string, unknown>).state).toBe('failed')
    })

    it('preserves a custom HAPI session name on re-import', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const transcript = opencodeTranscript('ses-1', ['one'])
        await importLocalTranscript({ store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE, transcript, machine: machine() })
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        store.sessions.updateSessionMetadata(session.id, { ...(session.metadata as Record<string, unknown>), name: 'My custom name' }, session.metadataVersion, 'default')
        await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['one', 'two']), machine: machine()
        })
        const renamed = store.sessions.getSessionByNamespace(session.id, 'default')!
        expect((renamed.metadata as Record<string, unknown>).name).toBe('My custom name')
    })

    it('reports already_in_hapi for a HAPI-created session bound to the native id', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const created = store.sessions.getOrCreateSession('live-tag', { flavor: 'opencode', opencodeSessionId: 'ses-1', machineId: 'm-1' }, null, 'default')
        store.messages.addImportedMessage(created.id, userContent('hello from hapi'), 'local-1', 1)
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: OPENCODE_LOCAL_SESSION_SOURCE,
            transcript: opencodeTranscript('ses-1', ['native history']), machine: machine()
        })
        expect(outcome).toMatchObject({
            hapiSessionId: created.id,
            error: { code: 'already_in_hapi' }
        })
    })
})