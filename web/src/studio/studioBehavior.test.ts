import { describe, expect, it } from 'vitest'
import {
    countNewStudioMessages,
    isStudioNearBottom,
    shouldCollapseStudioMessage
} from './studioBehavior'
import type { PublicStudioMessage } from '@/types/api'

function message(id: string): PublicStudioMessage {
    return { id, role: 'assistant', text: id, createdAt: 1, seq: 1 }
}

describe('Studio Lite conversation behavior', () => {
    it('treats a reader within the bottom threshold as following live output', () => {
        expect(isStudioNearBottom({ scrollHeight: 1000, scrollTop: 780, clientHeight: 120 })).toBe(true)
        expect(isStudioNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 120 })).toBe(false)
    })

    it('counts rows appended after the previous latest message', () => {
        expect(countNewStudioMessages('b', [message('a'), message('b'), message('c'), message('d')])).toBe(2)
        expect(countNewStudioMessages('missing', [message('c')])).toBe(1)
        expect(countNewStudioMessages(null, [message('a')])).toBe(0)
    })

    it('collapses only long assistant responses', () => {
        expect(shouldCollapseStudioMessage('short answer')).toBe(false)
        expect(shouldCollapseStudioMessage('x'.repeat(700))).toBe(true)
        expect(shouldCollapseStudioMessage(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'))).toBe(true)
    })
})
