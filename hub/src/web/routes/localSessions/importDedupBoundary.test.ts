import { afterEach, describe, expect, it } from 'bun:test'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import { RpcRegistry } from '../../../socket/rpcRegistry'
import { Store } from '../../../store'
import { SyncEngine, type Machine } from '../../../sync/syncEngine'
import { importLocalTranscript } from './importLocalTranscript'
import { CODEX_LOCAL_SESSION_SOURCE } from './sources'

/**
 * An explicit import only reuses a HAPI session recorded on the machine it
 * read the transcript from. The agent-id dedup that runs on keepalives and
 * resumes must keep the same machine boundary: it must not merge the
 * imported row into another machine's session, or the other way round.
 */

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'linux', happyCliVersion: 'test', workspaceRoots: ['/tmp/project'] },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userContent(text: string) {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const
}

function agentContent(message: string) {
    return {
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message, id: 'agent-1' } },
        meta: { sentFrom: 'cli' }
    } as const
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

function socketServerStub() {
    // Keepalives replay queued messages to the session's CLI room.
    const room = { emit() {} }
    return { of: () => ({ to: () => room }) }
}

async function settle(): Promise<void> {
    // Dedup runs as a fire-and-forget promise after session-updated.
    for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

describe('explicit import vs agent-id dedup', () => {
    const cleanups: Array<() => void> = []
    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) cleanup()
    })

    function setup() {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, socketServerStub() as never, new RpcRegistry(), { broadcast() {} } as never)
        cleanups.push(() => {
            engine.stop()
            store.close()
        })
        return { store, engine }
    }

    function seedSession(
        store: Store,
        engine: SyncEngine,
        tag: string,
        metadata: Record<string, unknown>,
        texts: string[]
    ): string {
        const session = engine.getOrCreateSession(tag, { path: '/tmp/project', host: 'h', ...metadata }, null, 'default')
        texts.forEach((text, index) => {
            store.messages.addMessage(session.id, userContent(text), `${tag}-${index}`)
        })
        return session.id
    }

    it("keeps an import apart from another machine's live session for the same Codex thread", async () => {
        const { store, engine } = setup()
        const otherMachineSession = seedSession(store, engine, 'codex-other-machine', {
            flavor: 'codex',
            machineId: 'machine-b',
            codexSessionId: 'thread-1'
        }, ['hello from machine b', 'b continues'])
        engine.handleSessionAlive({ sid: otherMachineSession, time: Date.now() })

        const outcome = await importLocalTranscript({
            store,
            engine,
            namespace: 'default',
            source: CODEX_LOCAL_SESSION_SOURCE,
            transcript: codexTranscript('thread-1', [userContent('hello'), agentContent('hi')]),
            machine: machine('machine-a')
        })
        expect(outcome).toMatchObject({ action: 'created', appended: 2 })
        // The live session on machine B keeps sending keepalives; each one
        // runs the agent-id dedup for that session.
        engine.handleSessionAlive({ sid: otherMachineSession, time: Date.now() })
        await settle()

        expect(store.sessions.getSessionByNamespace(outcome.hapiSessionId!, 'default')).not.toBeNull()
        expect(store.messages.getAllMessages(outcome.hapiSessionId!)).toHaveLength(2)
        expect(store.messages.getAllMessages(otherMachineSession)).toHaveLength(2)
    })

    it("keeps another machine's session when the imported Codex session goes live", async () => {
        const { store, engine } = setup()
        const otherMachineSession = seedSession(store, engine, 'codex-other-machine', {
            flavor: 'codex',
            machineId: 'machine-b',
            codexSessionId: 'thread-1'
        }, ['hello from machine b', 'b continues'])

        const outcome = await importLocalTranscript({
            store,
            engine,
            namespace: 'default',
            source: CODEX_LOCAL_SESSION_SOURCE,
            transcript: codexTranscript('thread-1', [userContent('hello'), agentContent('hi')]),
            machine: machine('machine-a')
        })
        expect(outcome).toMatchObject({ action: 'created', appended: 2 })
        // Create-after-import resumes the imported session on machine A.
        engine.handleSessionAlive({ sid: outcome.hapiSessionId!, time: Date.now() })
        await settle()

        expect(store.sessions.getSessionByNamespace(otherMachineSession, 'default')).not.toBeNull()
        expect(store.messages.getAllMessages(otherMachineSession)).toHaveLength(2)
        expect(store.messages.getAllMessages(outcome.hapiSessionId!)).toHaveLength(2)
    })

    it('creates a new session next to an archived one for the same Codex thread without touching it', async () => {
        // Scope: the import step only. The import does not reuse an archived
        // Codex session, so the thread then has two rows on one machine; once
        // the new row goes live, the agent-id dedup merges the archived row
        // into it exactly as it does for any same-machine duplicate. That
        // dedup behavior is independent of local-session import.
        const { store, engine } = setup()
        const archived = seedSession(store, engine, 'codex-archived', {
            flavor: 'codex',
            machineId: 'machine-a',
            codexSessionId: 'thread-1',
            lifecycleState: 'archived'
        }, ['archived turn'])

        const outcome = await importLocalTranscript({
            store,
            engine,
            namespace: 'default',
            source: CODEX_LOCAL_SESSION_SOURCE,
            transcript: codexTranscript('thread-1', [userContent('hello'), agentContent('hi')]),
            machine: machine('machine-a')
        })
        expect(outcome).toMatchObject({ action: 'created', appended: 2 })
        await settle()

        expect(store.sessions.getSessionByNamespace(outcome.hapiSessionId!, 'default')).not.toBeNull()
        expect(store.messages.getAllMessages(outcome.hapiSessionId!)).toHaveLength(2)
        const kept = store.sessions.getSessionByNamespace(archived, 'default')
        expect(kept).not.toBeNull()
        expect((kept!.metadata as Record<string, unknown>).lifecycleState).toBe('archived')
        expect(store.messages.getAllMessages(archived)).toHaveLength(1)
    })
})
