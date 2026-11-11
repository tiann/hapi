import { describe, expect, it, vi } from 'vitest'
import { readAgyConversationTitle } from './agySessionTitle'

describe('readAgyConversationTitle', () => {
    const conversationId = '00000000-0000-4000-8000-000000000001'

    it('reads and normalizes a native title', async () => {
        const query = vi.fn(async () => '  Native AGY title  ')

        await expect(readAgyConversationTitle(conversationId, query)).resolves.toBe('Native AGY title')
        expect(query).toHaveBeenCalledWith(conversationId)
    })

    it('ignores empty and placeholder native titles', async () => {
        const query = vi.fn(async () => 'New Session')

        await expect(readAgyConversationTitle(conversationId, query)).resolves.toBeNull()
    })

    it('rejects invalid conversation IDs before querying', async () => {
        const query = vi.fn(async () => 'Should not be read')

        await expect(readAgyConversationTitle('../other.db', query)).resolves.toBeNull()
        expect(query).not.toHaveBeenCalled()
    })

    it('treats database failures as an unavailable title', async () => {
        const query = vi.fn(async () => { throw new Error('database is locked') })

        await expect(readAgyConversationTitle(conversationId, query)).resolves.toBeNull()
    })
})
