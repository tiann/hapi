import { describe, expect, it } from 'vitest'
import type { AttachmentMetadata } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import {
    buildComposerMessageHistory,
    filterComposerMessageHistory,
    formatComposerHistoryPreview,
    getComposerHistoryTrigger,
} from './composerMessageHistory'

function userMessage(
    id: string,
    text: string,
    overrides: Partial<Extract<NormalizedMessage, { role: 'user' }>> = {},
): Extract<NormalizedMessage, { role: 'user' }> {
    return {
        id,
        localId: null,
        createdAt: Number(id.replace(/\D/g, '')) || 1,
        role: 'user',
        isSidechain: false,
        content: { type: 'text', text },
        ...overrides,
    }
}

function attachment(filename: string): AttachmentMetadata {
    return {
        id: filename,
        filename,
        mimeType: 'text/plain',
        size: 1,
        path: `/tmp/${filename}`,
    }
}

describe('getComposerHistoryTrigger', () => {
    it('accepts ASCII and fullwidth prefixes only at the absolute start', () => {
        expect(getComposerHistoryTrigger('#', { start: 1, end: 1 })).toEqual({ prefix: '#', query: '' })
        expect(getComposerHistoryTrigger('＃调查', { start: 3, end: 3 })).toEqual({ prefix: '＃', query: '调查' })
        expect(getComposerHistoryTrigger('# ', { start: 2, end: 2 })).toBeNull()
        expect(getComposerHistoryTrigger('＃　调查', { start: 4, end: 4 })).toBeNull()
        expect(getComposerHistoryTrigger('hello #调查', { start: 9, end: 9 })).toBeNull()
        expect(getComposerHistoryTrigger('第一行\n#调查', { start: 6, end: 6 })).toBeNull()
    })

    it('does not activate for selections or a cursor on a later line', () => {
        expect(getComposerHistoryTrigger('#调查', { start: 1, end: 2 })).toBeNull()
        expect(getComposerHistoryTrigger('#调查\n补充', { start: 6, end: 6 })).toBeNull()
    })
})

describe('buildComposerMessageHistory', () => {
    it('returns newest loaded user text first and preserves attachment metadata', () => {
        const messages = [
            userMessage('m1', '/help'),
            userMessage('m2', '', { content: { type: 'text', text: '', attachments: [attachment('a.txt')] } }),
            userMessage('m3', '包含附件', { content: { type: 'text', text: '包含附件', attachments: [attachment('b.txt')] } }),
            userMessage('m4', 'sidechain', { isSidechain: true }),
            userMessage('m5', '最新消息'),
            userMessage('m5', 'duplicate id'),
            userMessage('m6', 'failed send', { status: 'failed' }),
        ]

        expect(buildComposerMessageHistory(messages)).toEqual([
            {
                id: 'm5',
                text: 'duplicate id',
                attachments: [],
                createdAt: 5,
            },
            {
                id: 'm3',
                text: '包含附件',
                attachments: [attachment('b.txt')],
                createdAt: 3,
            },
            {
                id: 'm1',
                text: '/help',
                attachments: [],
                createdAt: 1,
            },
        ])
    })

    it('filters loaded history case-insensitively without changing entry order', () => {
        const entries = buildComposerMessageHistory([
            userMessage('m1', 'Open the README'),
            userMessage('m2', 'fix the button'),
            userMessage('m3', 'readme checklist'),
        ])

        expect(filterComposerMessageHistory(entries, 'README').map((entry) => entry.id)).toEqual(['m3', 'm1'])
        expect(filterComposerMessageHistory(entries, '   ')).toEqual(entries)
    })
})

describe('formatComposerHistoryPreview', () => {
    it('collapses multiline text for the candidate label', () => {
        expect(formatComposerHistoryPreview('  first line\nsecond\tline  ')).toBe('first line second line')
    })
})
