import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { claudeToTranscript } from '@hapi/protocol/localTranscript'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import { Store } from '../../../store'
import { importLocalTranscript } from './importLocalTranscript'
import { CLAUDE_LOCAL_SESSION_SOURCE } from './sources'

/**
 * Claude Code copies the earlier entries into the new transcript when a
 * session resumes: the uuids stay, but sessionId and timestamp are rewritten.
 * The CLI session scanner fixtures are real before/after resume files.
 */
const FIXTURES = join(import.meta.dir, '../../../../../cli/src/claude/utils/__fixtures__')
const FIRST_SESSION = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
const RESUMED_SESSION = '789e105f-ae33-486d-9271-0696266f072d'

type RawEntry = Record<string, unknown> & {
    type?: string
    uuid?: string
    timestamp?: string
    message?: { content?: unknown }
}

function readEntries(name: string): RawEntry[] {
    return readFileSync(join(FIXTURES, name), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RawEntry)
}

function externalUserText(entry: RawEntry): string | null {
    if (entry.type !== 'user') return null
    const content = entry.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === 'text')) {
        return content.map((block) => String(block.text)).join('')
    }
    return null
}

/** Row mapping of the CLI reader: user text stays text, any other entry is kept whole. */
function transcriptOf(sessionId: string, entries: RawEntry[]): LocalTranscript {
    const messages: ClaudeLocalSessionWithMessages['messages'] = entries
        .filter((entry) => (entry.type === 'user' || entry.type === 'assistant') && typeof entry.uuid === 'string')
        .map((entry) => {
            const text = externalUserText(entry)
            return {
                uuid: entry.uuid!,
                createdAt: Date.parse(entry.timestamp!),
                content: text !== null
                    ? { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }
                    : { role: 'agent', content: { type: 'output', data: entry }, meta: { sentFrom: 'cli' } }
            }
        })
    return claudeToTranscript({
        id: sessionId,
        title: 'Resumed fixture',
        lastUserMessage: null,
        cwd: '/tmp/project',
        file: `/tmp/${sessionId}.jsonl`,
        modifiedAt: 1,
        messageCount: messages.length,
        messages
    })
}

function machine(): Machine {
    return {
        id: 'm-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: 'm-1.local', platform: 'linux', happyCliVersion: 'test', workspaceRoots: ['/tmp/project'] },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function harness() {
    const store = new Store(':memory:')
    const engine = {
        recordSessionActivity: () => {},
        handleRealtimeEvent: () => {},
        applySessionConfig: async () => {},
        getSessionsByNamespace: () => [],
        getOnlineMachinesByNamespace: () => [machine()]
    } as unknown as SyncEngine
    return { store, engine }
}

describe('Claude import across a resume', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('appends the resumed transcript when copied entries only changed replay metadata', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const first = await importLocalTranscript({
            store, engine, namespace: 'default', source: CLAUDE_LOCAL_SESSION_SOURCE,
            transcript: transcriptOf(FIRST_SESSION, readEntries('0-say-lol-session.jsonl')),
            machine: machine()
        })
        expect(first).toMatchObject({ action: 'created', appended: 2 })

        // The resume rotated the native id; the live machinery records it.
        const session = store.sessions.getSessionByNamespace(first.hapiSessionId!, 'default')!
        store.sessions.updateSessionMetadata(
            session.id,
            { ...(session.metadata as Record<string, unknown>), claudeSessionId: RESUMED_SESSION, claudeSessionIdHistory: [FIRST_SESSION] },
            session.metadataVersion,
            'default'
        )

        const resumed = transcriptOf(RESUMED_SESSION, readEntries('1-continue-run-ls-tool.jsonl'))
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: CLAUDE_LOCAL_SESSION_SOURCE,
            transcript: resumed,
            machine: machine()
        })
        expect(outcome).toMatchObject({ hapiSessionId: session.id, action: 'updated', appended: resumed.messages.length - 2 })
    })

    it('still rejects a copied entry whose message content changed', async () => {
        const { store, engine } = harness()
        stores.push(store)
        const first = await importLocalTranscript({
            store, engine, namespace: 'default', source: CLAUDE_LOCAL_SESSION_SOURCE,
            transcript: transcriptOf(FIRST_SESSION, readEntries('0-say-lol-session.jsonl')),
            machine: machine()
        })
        const session = store.sessions.getSessionByNamespace(first.hapiSessionId!, 'default')!
        store.sessions.updateSessionMetadata(
            session.id,
            { ...(session.metadata as Record<string, unknown>), claudeSessionId: RESUMED_SESSION, claudeSessionIdHistory: [FIRST_SESSION] },
            session.metadataVersion,
            'default'
        )

        const edited = readEntries('1-continue-run-ls-tool.jsonl').map((entry) => {
            if (entry.type !== 'assistant' || entry.uuid !== 'deae7c10-1e9a-466a-bbd0-1cd31b43d823') return entry
            const message = entry.message as { content: Array<Record<string, unknown>> }
            return { ...entry, message: { ...message, content: [{ type: 'text', text: 'edited reply' }] } }
        })
        const outcome = await importLocalTranscript({
            store, engine, namespace: 'default', source: CLAUDE_LOCAL_SESSION_SOURCE,
            transcript: transcriptOf(RESUMED_SESSION, edited),
            machine: machine()
        })
        expect(outcome.error?.code).toBe('transcript_diverged')
    })
})
