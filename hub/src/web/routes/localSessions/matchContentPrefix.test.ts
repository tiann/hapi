import { describe, expect, it } from 'bun:test'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import type { StoredMessage } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'
import { matchContentPrefix, type ImportCandidate } from './matchContentPrefix'
import { codexCompareKey } from './sources'

const NATIVE_ID = 'thread-1'
const KEYS = ['codexSessionId', 'codexSourceSessionId']

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

function codexTranscript(contents: unknown[]): LocalTranscript {
    return {
        flavor: 'codex',
        id: NATIVE_ID,
        title: 't',
        file: '/tmp/thread-1.jsonl',
        modifiedAt: 1,
        messages: contents.map((content, index) => ({
            id: `codex-desktop:${NATIVE_ID}:${index}`,
            content: content as LocalTranscript['messages'][number]['content']
        }))
    }
}

function storedMessage(localId: string, content: unknown): StoredMessage {
    return {
        id: `stored-${localId}`,
        sessionId: 'hapi-1',
        content,
        createdAt: 1,
        seq: 1,
        localId,
        invokedAt: null,
        scheduledAt: null
    }
}

function candidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
    return {
        sessionId: 'hapi-1',
        active: false,
        updatedAt: 1,
        metadata: { codexSessionId: NATIVE_ID, flavor: 'codex' },
        persisted: true,
        ...overrides
    }
}

function harness(candidates: ImportCandidate[], storedBySession: Record<string, StoredMessage[]>) {
    return {
        candidates,
        getAllMessages: (sessionId: string) => storedBySession[sessionId] ?? []
    }
}

describe('contentPrefix match', () => {
    it('blocks the sync when any related candidate is active, delta or not', () => {
        const { candidates, getAllMessages } = harness([candidate({ active: true })], { 'hapi-1': [] })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'session_active' })
    })

    it('excludes archived and deleted candidates', () => {
        const { candidates, getAllMessages } = harness(
            [candidate({ sessionId: 'hapi-a', metadata: { codexSessionId: NATIVE_ID, lifecycleState: 'archived' } })],
            { 'hapi-a': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))] }
        )
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: null, deltaStartIndex: 0 })
    })

    it('picks the candidate with the longest matching prefix', () => {
        const { candidates, getAllMessages } = harness(
            [
                candidate({ sessionId: 'hapi-short', updatedAt: 9 }),
                candidate({ sessionId: 'hapi-long' })
            ],
            {
                'hapi-short': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))],
                'hapi-long': [
                    storedMessage('codex-desktop:thread-1:0', userContent('hello')),
                    storedMessage('codex-desktop:thread-1:1', agentContent('x', 'running'))
                ]
            }
        )
        const transcript = codexTranscript([userContent('hello'), agentContent('x', 'running'), userContent('next')])
        const result = matchContentPrefix({
            candidates,
            transcript,
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-long', deltaStartIndex: 2 })
    })

    it('matches through the alias key (fork provenance)', () => {
        const { candidates, getAllMessages } = harness(
            [candidate({ metadata: { codexSourceSessionId: NATIVE_ID } })],
            { 'hapi-1': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))] }
        )
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello'), userContent('next')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 1 })
    })

    it('ignores engine-only (unpersisted) candidates as targets', () => {
        const { candidates, getAllMessages } = harness(
            [candidate({ sessionId: 'hapi-engine', persisted: false })],
            { 'hapi-engine': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))] }
        )
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: null, deltaStartIndex: 0 })
    })

    it('respects the machine filter: same machine or unset only', () => {
        const mismatch = harness([candidate({ sessionId: 'hapi-1', metadata: { codexSessionId: NATIVE_ID, machineId: 'other' } })], {
            'hapi-1': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))]
        })
        const unset = harness([candidate({ sessionId: 'hapi-1', metadata: { codexSessionId: NATIVE_ID } })], {
            'hapi-1': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))]
        })
        const same = harness([candidate({ sessionId: 'hapi-1', metadata: { codexSessionId: NATIVE_ID, machineId: 'm-1' } })], {
            'hapi-1': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))]
        })
        const transcript = codexTranscript([userContent('hello')])
        for (const [setup, expected] of [[mismatch, null], [unset, 'hapi-1'], [same, 'hapi-1']] as const) {
            const result = matchContentPrefix({
                candidates: setup.candidates,
                transcript,
                nativeIdKeys: KEYS,
                sourceMachineId: 'm-1',
                getAllMessages: setup.getAllMessages
            })
            expect(result.status).toBe('ok')
            if (result.status === 'ok') expect(result.targetSessionId).toBe(expected)
        }
    })

    it('absorbs a trailing stored duplicate the transcript collapsed and maps the delta past it', () => {
        const duplicate = agentContent('x', 'running')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('hello')),
                storedMessage('codex-desktop:thread-1:1', duplicate),
                storedMessage('codex-desktop:thread-1:2', duplicate)
            ]
        })
        // The source transcript was de-duplicated on conversion: the adjacent
        // duplicate run collapsed to one message. Without absorbing it, the stored
        // run [dup, dup] would break the prefix at the third key.
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello'), duplicate, userContent('next')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })

    it('compares agent payloads while ignoring generated ids', () => {
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('hello')),
                storedMessage('codex-desktop:thread-1:1', agentContent('old-id', 'running'))
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello'), agentContent('new-id', 'running'), userContent('next')]),
            nativeIdKeys: KEYS,
            compareKey: codexCompareKey,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })

    it('appends an identical tail turn instead of folding it away', () => {
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [storedMessage('codex-desktop:thread-1:0', userContent('hello'))]
        })
        // Two identical same-source turns are real turns: the appended
        // duplicate must not be folded into the stored prefix.
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello'), userContent('hello')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 1 })
    })

    it('absorbs a stored duplicate the transcript collapsed before a later turn', () => {
        const duplicate = userContent('hello')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', duplicate),
                storedMessage('codex-desktop:thread-1:1', duplicate),
                storedMessage('codex-desktop:thread-1:2', agentContent('x', 'running'))
            ]
        })
        // A runner that still collapses adjacent duplicates converts the
        // stored [hello, hello] run to one hello: the run lengths differ,
        // the keys around it agree, so only the new turn is appended.
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello'), agentContent('x', 'running'), userContent('next')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })

    it('absorbs a mid-history stored duplicate run collapsed by the transcript', () => {
        const duplicate = agentContent('x', 'running')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('A')),
                storedMessage('codex-desktop:thread-1:1', duplicate),
                storedMessage('codex-desktop:thread-1:2', duplicate),
                storedMessage('codex-desktop:thread-1:3', userContent('B'))
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('A'), duplicate, userContent('B'), userContent('C')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 3 })
    })

    it('absorbs a mid-history transcript duplicate run the stored session collapsed', () => {
        const duplicate = agentContent('x', 'running')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('A')),
                storedMessage('codex-desktop:thread-1:1', duplicate),
                storedMessage('codex-desktop:thread-1:2', userContent('B'))
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('A'), duplicate, duplicate, userContent('B'), userContent('C')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 4 })
    })

    it('reports nothing new when the transcript only collapsed a trailing stored run', () => {
        const duplicate = agentContent('x', 'running')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('A')),
                storedMessage('codex-desktop:thread-1:1', duplicate),
                storedMessage('codex-desktop:thread-1:2', duplicate)
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('A'), duplicate]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })

    it('rejects stored turns separated by transcript content they never had', () => {
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('A')),
                storedMessage('codex-desktop:thread-1:1', userContent('B'))
            ]
        })
        const transcripts = [
            // A rewritten middle: X and Y were never stored between A and B.
            [userContent('A'), userContent('X'), userContent('Y'), userContent('B'), userContent('C')],
            // Prepended history: the stored session does not start the transcript.
            [userContent('X'), userContent('A'), userContent('B'), userContent('C')],
            // A gap made of an earlier, non-adjacent key is still a gap.
            [userContent('A'), userContent('A'), userContent('X'), userContent('B')]
        ]
        for (const contents of transcripts) {
            const result = matchContentPrefix({
                candidates,
                transcript: codexTranscript(contents),
                nativeIdKeys: KEYS,
                getAllMessages
            })
            expect(result).toMatchObject({ status: 'ok', targetSessionId: null, deltaStartIndex: 0 })
        }
    })

    it('rejects a stored session holding turns the transcript does not have', () => {
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('A')),
                storedMessage('codex-desktop:thread-1:1', userContent('X')),
                storedMessage('codex-desktop:thread-1:2', userContent('B'))
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('A'), userContent('B')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: null, deltaStartIndex: 0 })
    })

    it('rejects a diverged turn even when the run before it is duplicated', () => {
        const duplicate = userContent('hello')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', duplicate),
                storedMessage('codex-desktop:thread-1:1', duplicate),
                storedMessage('codex-desktop:thread-1:2', agentContent('x', 'running'))
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([duplicate, agentContent('x', 'different'), userContent('next')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: null, deltaStartIndex: 0 })
    })

    it('appends plain growth after the stored prefix', () => {
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('A')),
                storedMessage('codex-desktop:thread-1:1', userContent('B'))
            ]
        })
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('A'), userContent('B'), userContent('C')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })

    it('prefers the most recently updated candidate when two explain the same prefix', () => {
        const stored = [storedMessage('codex-desktop:thread-1:0', userContent('A'))]
        const { candidates, getAllMessages } = harness(
            [
                candidate({ sessionId: 'hapi-older', updatedAt: 1 }),
                candidate({ sessionId: 'hapi-newer', updatedAt: 5 })
            ],
            { 'hapi-older': stored, 'hapi-newer': stored }
        )
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('A'), userContent('B')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-newer', deltaStartIndex: 1 })
    })

    it('appends the missing duplicates when a pre-dedupe stored run shows up expanded', () => {
        const duplicate = agentContent('x', 'running')
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', userContent('hello')),
                storedMessage('codex-desktop:thread-1:1', duplicate)
            ]
        })
        // The stored row kept one copy of the mirrored run; the
        // re-converted transcript shows it expanded and the extra duplicate
        // plus the new turn must be appended, not folded away.
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([userContent('hello'), duplicate, duplicate, userContent('next')]),
            nativeIdKeys: KEYS,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })

    it('matches an oversized agent message against its truncated stored row', () => {
        const huge = 'x'.repeat(70 * 1024)
        const { candidates, getAllMessages } = harness([candidate()], {
            'hapi-1': [
                storedMessage('codex-desktop:thread-1:0', truncateOversizedMessageContent(agentContent('x', huge)) as unknown),
                storedMessage('codex-desktop:thread-1:1', userContent('next'))
            ]
        })
        // The store truncates oversized agent payloads at ingest while the
        // runner transcript arrives in full: the compare key must apply the
        // same truncation or the re-sync forks a duplicate session.
        const result = matchContentPrefix({
            candidates,
            transcript: codexTranscript([agentContent('x', huge), userContent('next'), userContent('newer turn')]),
            nativeIdKeys: KEYS,
            compareKey: codexCompareKey,
            getAllMessages
        })
        expect(result).toMatchObject({ status: 'ok', targetSessionId: 'hapi-1', deltaStartIndex: 2 })
    })
})