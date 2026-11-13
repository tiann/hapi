import { describe, expect, it } from 'bun:test'
import type {
    CodexLocalSessionWithMessages,
    OpencodeLocalSessionWithMessages,
    PiLocalSessionWithMessages
} from './apiTypes'
import {
    ListLocalSessionsRpcResponseSchema,
    LocalTranscriptSchema,
    codexToTranscript,
    opencodeToTranscript,
    piToTranscript
} from './localTranscript'

const piSession: PiLocalSessionWithMessages = {
    id: 'pi-1',
    title: 'Pi session',
    lastUserMessage: 'second question',
    cwd: '/tmp/project',
    file: '/tmp/pi-1.jsonl',
    modifiedAt: 1_234,
    model: 'gemini-3.8-flash',
    thinkingLevel: 'low',
    leafEntryId: 'entry-3',
    messageCount: 3,
    messages: [
        {
            localId: 'pi:pi-1:entry-1:user',
            entryId: 'entry-1',
            parentEntryId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'first question' }, meta: { sentFrom: 'cli' } }
        },
        {
            localId: 'pi:pi-1:entry-2:0',
            entryId: 'entry-2',
            parentEntryId: 'entry-1',
            createdAt: 1_100,
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'answer one', id: 'pi:pi-1:entry-2:0' } },
                meta: { sentFrom: 'cli' }
            }
        },
        {
            localId: 'pi:pi-1:entry-3:user',
            entryId: 'entry-3',
            parentEntryId: 'entry-2',
            createdAt: 1_200,
            content: { role: 'user', content: { type: 'text', text: 'second question' }, meta: { sentFrom: 'cli' } }
        }
    ],
    activeEntryIds: ['entry-1', 'entry-2', 'entry-3']
}

const opencodeSession: OpencodeLocalSessionWithMessages = {
    id: 'ses_1',
    title: 'OpenCode session',
    lastUserMessage: 'fix the bug',
    cwd: '/tmp/project',
    file: '/tmp/opencode.db',
    modifiedAt: 2_000,
    messages: [
        {
            localId: 'opencode:ses_1:msg-1:part-1',
            createdAt: 2_100,
            content: { role: 'user', content: { type: 'text', text: 'fix the bug' }, meta: { sentFrom: 'cli' } }
        },
        {
            localId: 'opencode:ses_1:msg-2:part-1',
            createdAt: 2_200,
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'on it', id: 'part-1' } },
                meta: { sentFrom: 'cli' }
            }
        }
    ]
}

const codexSession: CodexLocalSessionWithMessages = {
    id: 'thread-1',
    title: 'Codex session',
    lastUserMessage: 'run the tests',
    cwd: '/tmp/project',
    file: '/tmp/thread-1.jsonl',
    modifiedAt: 3_000,
    originator: 'codex-cli',
    cliVersion: '1.2.3',
    source: 'vscode',
    threadSource: 'local',
    forkedFromId: null,
    messages: [
        { role: 'user', content: { type: 'text', text: 'run the tests' }, meta: { sentFrom: 'cli' } },
        {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'running', id: 'generated' } },
            meta: { sentFrom: 'cli' }
        }
    ]
}

describe('local transcript mappers', () => {
    it('maps Pi sessions with anchors, cursor and launch hints', () => {
        const transcript = piToTranscript(piSession)
        expect(transcript.flavor).toBe('pi')
        expect(transcript.id).toBe('pi-1')
        expect(transcript.messages.map((message) => message.id)).toEqual([
            'pi:pi-1:entry-1:user',
            'pi:pi-1:entry-2:0',
            'pi:pi-1:entry-3:user'
        ])
        expect(transcript.messages.map((message) => message.anchor)).toEqual(['entry-1', 'entry-2', 'entry-3'])
        expect(transcript.messages.filter((message) => message.content.role === 'user').map((message) => message.historyPoint))
            .toEqual(['entry-1', 'entry-3'])
        expect(transcript.anchorOrder).toEqual(['entry-1', 'entry-2', 'entry-3'])
        expect(transcript.cursor).toBe('entry-3')
        expect(transcript.launch).toEqual({ model: 'gemini-3.8-flash', effort: 'low' })
        expect(transcript.extra).toEqual({
            model: 'gemini-3.8-flash',
            thinkingLevel: 'low',
            leafEntryId: 'entry-3'
        })
        expect(transcript.messageCount).toBe(3)
        expect(LocalTranscriptSchema.parse(transcript)).toBeDefined()
    })

    it('maps OpenCode sessions without anchors or cursor', () => {
        const transcript = opencodeToTranscript(opencodeSession)
        expect(transcript.flavor).toBe('opencode')
        expect(transcript.messages.map((message) => message.id)).toEqual([
            'opencode:ses_1:msg-1:part-1',
            'opencode:ses_1:msg-2:part-1'
        ])
        expect(transcript.messages.every((message) => message.anchor === undefined)).toBe(true)
        expect(transcript.anchorOrder).toBeUndefined()
        expect(transcript.cursor).toBeUndefined()
        expect(transcript.launch).toBeUndefined()
        expect(transcript.extra).toBeUndefined()
        expect(transcript.messageCount).toBeUndefined()
        expect(LocalTranscriptSchema.parse(transcript)).toBeDefined()
    })

    it('maps Codex messages to indexed ids without createdAt', () => {
        const transcript = codexToTranscript(codexSession)
        expect(transcript.flavor).toBe('codex')
        expect(transcript.messages.map((message) => message.id)).toEqual([
            'codex-desktop:thread-1:0',
            'codex-desktop:thread-1:1'
        ])
        expect(transcript.messages.every((message) => message.createdAt === undefined)).toBe(true)
        expect(transcript.extra).toEqual({
            originator: 'codex-cli',
            cliVersion: '1.2.3',
            source: 'vscode',
            threadSource: 'local',
            forkedFromId: null
        })
        expect(LocalTranscriptSchema.parse(transcript)).toBeDefined()
    })

    it('parses the ListLocalSessions RPC response envelope', () => {
        expect(ListLocalSessionsRpcResponseSchema.parse({
            success: true,
            sessions: [piToTranscript(piSession), opencodeToTranscript(opencodeSession)]
        }).success).toBe(true)
        expect(ListLocalSessionsRpcResponseSchema.parse({ success: false, error: 'nope' }).success).toBe(false)
    })
})