import { describe, expect, it } from 'vitest'
import { moveAttachmentId, orderItemsById, reconcileAttachmentOrder } from './attachmentOrder'

describe('attachment order helpers', () => {
    it('keeps existing order while appending newly added attachments', () => {
        expect(reconcileAttachmentOrder(['b', 'stale', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    })

    it('moves an attachment immediately before the drop target', () => {
        expect(moveAttachmentId(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
        expect(moveAttachmentId(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
        expect(moveAttachmentId(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
    })

    it('orders objects without dropping ids unknown to the order list', () => {
        const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
        expect(orderItemsById(items, ['c', 'a'])).toEqual([{ id: 'c' }, { id: 'a' }, { id: 'b' }])
    })
})
