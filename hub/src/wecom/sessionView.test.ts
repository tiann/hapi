import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import {
    buildPermissionCard,
    buildReadyCard,
    buildTaskCard,
    buildSessionCompletionCard,
    buildSystemReplyCard
} from './sessionView'

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'abcdef0123456789',
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { path: '/tmp/proj', host: 'mac' },
        metadataVersion: 0,
        agentState: {
            requests: {
                'req98765432abcdef': {
                    tool: 'Bash',
                    arguments: { command: 'ls -la' }
                }
            }
        },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    } as Session
}

describe('buildPermissionCard', () => {
    it('returns a button_interaction card with Allow / Deny keyed on session+request prefixes', () => {
        const card = buildPermissionCard(session(), 'https://hapi.example.com')
        if (!card) throw new Error('expected a permission card')
        expect(card.card_type).toBe('button_interaction')
        expect(card.main_title?.title).toBe('Permission Request')
        expect(card.button_list).toHaveLength(2)
        expect(card.button_list![0]).toEqual({
            text: 'Allow',
            style: 1,
            key: 'ap:abcdef01:req98765'
        })
        expect(card.button_list![1]).toEqual({
            text: 'Deny',
            style: 2,
            key: 'dn:abcdef01:req98765'
        })
        expect(card.task_id).toMatch(/^hapi-abcdef01-req98765-\d+$/)
    })

    it('returns null when there are no pending requests', () => {
        const card = buildPermissionCard(session({ agentState: null }), 'https://hapi.example.com')
        expect(card).toBeNull()
    })
})

describe('buildReadyCard', () => {
    it('returns a text_notice card with a session URL action', () => {
        const card = buildReadyCard(session(), 'https://hapi.example.com')
        expect(card.card_type).toBe('text_notice')
        expect(card.main_title?.title).toBe('Ready for input')
        expect(card.card_action).toEqual({
            type: 1,
            url: 'https://hapi.example.com/sessions/abcdef0123456789'
        })
    })
})

describe('buildTaskCard', () => {
    it('marks failed tasks with a failure title', () => {
        const card = buildTaskCard(session(), { status: 'failed', summary: 'Boom' }, 'https://hapi.example.com')
        expect(card.main_title?.title).toBe('Task failed')
    })

    it('marks completed tasks with a success title', () => {
        const card = buildTaskCard(session(), { status: 'completed', summary: 'Done' }, 'https://hapi.example.com')
        expect(card.main_title?.title).toBe('Task completed')
    })
})

describe('buildSessionCompletionCard', () => {
    it('returns a text_notice card', () => {
        const card = buildSessionCompletionCard(session(), 'https://hapi.example.com')
        expect(card.card_type).toBe('text_notice')
        expect(card.main_title?.title).toBe('Session completed')
    })
})

describe('buildSystemReplyCard', () => {
    it('builds a notice card with the given title and a card_action', () => {
        const card = buildSystemReplyCard('Permission approved.', 'https://hapi.example.com/sessions/abc')
        expect(card.card_type).toBe('text_notice')
        expect(card.main_title?.title).toBe('Permission approved.')
        expect(card.button_list).toBeUndefined()
        // WeCom rejects template cards without card_action with errcode 42045.
        expect(card.card_action).toEqual({ type: 1, url: 'https://hapi.example.com/sessions/abc' })
    })
})
