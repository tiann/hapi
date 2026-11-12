import { describe, expect, it } from 'vitest'
import {
    getPendingRequestDetail,
    getPendingRequestEntries,
    getPendingRequestNavigationTarget,
    getPendingRequestReferenceId,
    getPendingRequestStatusText
} from './pendingRequests'

describe('pending request helpers', () => {
    it('sorts and classifies input before rendering a status', () => {
        const entries = getPendingRequestEntries({
            permission: { tool: 'Bash', createdAt: 20, arguments: {} },
            question: { tool: 'request_user_input', createdAt: 10, arguments: {} },
        })
        expect(entries.map(({ id, kind }) => ({ id, kind }))).toEqual([
            { id: 'question', kind: 'input' },
            { id: 'permission', kind: 'permission' },
        ])
        const t = (key: string, params?: Record<string, string | number>) => `${key}:${params?.count ?? ''}`
        expect(getPendingRequestStatusText(entries.slice(0, 1), t)).toBe('misc.inputRequired:')
        expect(getPendingRequestStatusText(entries.slice(1), t)).toBe('misc.permissionRequired:')
        expect(getPendingRequestStatusText(entries, t)).toBe('misc.pendingRequests:2')
    })

    it('uses a correlated tool id whenever the agent supplies one', () => {
        expect(getPendingRequestReferenceId('request-key', {
            tool: 'request_user_input',
            toolCallId: 'nested-call',
            arguments: {},
        })).toBe('nested-call')
        expect(getPendingRequestReferenceId('request-key', { tool: 'Bash', arguments: {} }))
            .toBe('request-key')
    })

    it('maps async questions to the live panel and blocking requests to the tool card', () => {
        const request = { tool: 'request_user_input', toolCallId: 'call-1', arguments: {} }
        expect(getPendingRequestNavigationTarget('request-key', request, true)).toEqual({ kind: 'async' })
        expect(getPendingRequestNavigationTarget('request-key', request, false)).toEqual({
            kind: 'message',
            messageId: 'tool-call:call-1',
        })
    })
    it('uses a generated request key for a synthesized Cursor question', () => {
        expect(getPendingRequestNavigationTarget('generated-request', { tool: 'CursorAskQuestion', arguments: {} }, false)).toEqual({
            kind: 'message',
            messageId: 'tool-call:generated-request',
        })
    })
    it('extracts readable question and approval details for the popover', () => {
        const entries = getPendingRequestEntries({
            question: {
                tool: 'request_user_input',
                createdAt: 10,
                arguments: {
                    questions: [
                        { question: 'Which implementation approach should I use?' },
                        { question: 'Should I add screenshots?' },
                    ],
                },
            },
            approval: {
                tool: 'Bash',
                createdAt: 20,
                arguments: { command: 'git status --short', description: 'Inspect the worktree' },
            },
            cursor: {
                tool: 'CursorAskQuestion',
                createdAt: 30,
                arguments: { prompt: 'Choose a Cursor path' },
            },
        })

        expect(getPendingRequestDetail(entries[0]!)).toEqual({
            text: 'Which implementation approach should I use?',
            moreCount: 1,
        })
        expect(getPendingRequestDetail(entries[1]!)).toEqual({
            text: 'git status --short',
            moreCount: 0,
        })
        expect(entries[2]).toMatchObject({ kind: 'input', tool: 'CursorAskQuestion' })
        expect(getPendingRequestDetail(entries[2]!)).toEqual({
            text: 'Choose a Cursor path',
            moreCount: 0,
        })
    })
})