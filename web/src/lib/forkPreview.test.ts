import { describe, expect, it } from 'vitest'
import { buildForkPreview } from './forkPreview'
import type { VisibleChatBlock } from '@/chat/toolGroups'

function user(text: string, localId: string): VisibleChatBlock {
    return {
        kind: 'user-text',
        id: localId,
        localId,
        createdAt: 0,
        invokedAt: 0,
        text,
    }
}

function agent(text: string): VisibleChatBlock {
    return {
        kind: 'agent-text',
        id: `a-${text}`,
        localId: null,
        createdAt: 1,
        text,
    }
}

describe('buildForkPreview', () => {
    const blocks: VisibleChatBlock[] = [
        user('first question', 'u1'),
        agent('first answer'),
        user('second question', 'u2'),
        agent('second answer'),
        user('third question', 'u3'),
        agent('third answer'),
    ]

    it('keeps everything before the boundary and quotes the boundary message', () => {
        const preview = buildForkPreview(blocks, 'u3')
        expect(preview.keptTurns).toHaveLength(3)
        expect(preview.keptTurns.map((turn) => turn.role)).toEqual(['assistant', 'user', 'assistant'])
        expect(preview.keptTurns[0].text).toBe('first answer')
        expect(preview.keptTurns[1].text).toBe('second question')
        expect(preview.boundaryText).toBe('third question')
    })

    it('treats a missing boundary id as an empty preview', () => {
        const preview = buildForkPreview(blocks, 'missing')
        expect(preview.keptTurns).toEqual([])
        expect(preview.boundaryText).toBeNull()
    })

    it('keeps the whole transcript for a current fork with no boundary message', () => {
        const preview = buildForkPreview(blocks)
        expect(preview.keptTurns).toHaveLength(3)
        expect(preview.keptTurns[2].text).toBe('third answer')
        expect(preview.boundaryText).toBeNull()
    })

    it('merges consecutive same-role blocks into one turn and truncates long text', () => {
        const merged: VisibleChatBlock[] = [
            agent(`"${'x'.repeat(300)}"`),
            agent('more of the same answer'),
            user('q', 'u9'),
        ]
        const preview = buildForkPreview(merged, 'u9')
        expect(preview.keptTurns).toHaveLength(1)
        expect(preview.keptTurns[0].role).toBe('assistant')
        expect(preview.keptTurns[0].text.startsWith('"xxx')).toBe(true)
        expect(preview.keptTurns[0].text.endsWith('…')).toBe(true)
        expect(preview.boundaryText).toBe('q')
    })

    it('skips system and empty-text blocks', () => {
        const noisy: VisibleChatBlock[] = [
            { kind: 'agent-event', id: 'e1', createdAt: 0, event: { type: 'status' } } as unknown as VisibleChatBlock,
            user('   ', 'u-empty'),
            user('real question', 'u-real'),
        ]
        const preview = buildForkPreview(noisy, 'u-real')
        expect(preview.keptTurns).toEqual([])
        expect(preview.boundaryText).toBe('real question')
    })

    it('omits queued (never-invoked) user blocks that the hub does not copy', () => {
        const withQueued: VisibleChatBlock[] = [
            user('answered question', 'u1'),
            agent('answer'),
            { ...user('queued prompt', 'u2'), invokedAt: null },
        ]
        const preview = buildForkPreview(withQueued)
        expect(preview.keptTurns.map((turn) => turn.text)).toEqual(['answered question', 'answer'])
    })

    it('reports the fork kind for historical and current forks', () => {
        expect(buildForkPreview(blocks, 'u3').kind).toBe('historical')
        expect(buildForkPreview(blocks).kind).toBe('current')
    })

    it('reports when earlier copied turns are omitted from the preview', () => {
        expect(buildForkPreview(blocks, 'u3').prefixTruncated).toBe(true)
        expect(buildForkPreview(blocks, 'u2').prefixTruncated).toBe(false)
    })

    it('reports when copied non-text content is omitted from the preview', () => {
        const withReasoning: VisibleChatBlock[] = [
            user('question', 'u1'),
            {
                kind: 'agent-reasoning',
                id: 'r1',
                localId: null,
                createdAt: 1,
                text: 'private chain of thought',
            },
            agent('answer'),
        ]
        const preview = buildForkPreview(withReasoning)
        expect(preview.keptTurns.map((turn) => turn.text)).toEqual(['question', 'answer'])
        expect(preview.prefixTruncated).toBe(true)
    })

    it('includes attachment-only user messages by their filenames', () => {
        const attachmentOnly: VisibleChatBlock[] = [
            { ...user('', 'u-file'), attachments: [{ id: 'a1', filename: 'report.pdf', mimeType: 'application/pdf', size: 10, path: '/tmp/report.pdf' }] } as VisibleChatBlock,
            user('next question', 'u2'),
        ]
        const preview = buildForkPreview(attachmentOnly, 'u2')
        expect(preview.keptTurns.map((turn) => turn.text)).toEqual(['report.pdf'])
        expect(preview.boundaryText).toBe('next question')
    })
})
