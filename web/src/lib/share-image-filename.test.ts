import { describe, expect, it } from 'vitest'
import { getShareImageFileName, getShareTableFileName, sanitizeShareFileNamePart } from './share-image-filename'

describe('share image filenames', () => {
    const timestamp = new Date(2026, 7, 18, 10, 27, 56)

    it('keeps turn image filenames compatible with the existing HAPI convention', () => {
        expect(getShareImageFileName('标题', 'turn', timestamp)).toBe('HAPI-标题-20260818102756.png')
    })

    it('adds the Table discriminator while retaining the conversation title and timestamp', () => {
        expect(getShareImageFileName('标题', 'table', timestamp)).toBe('HAPI Table-标题-20260818102756.png')
    })

    it('uses the same table title and timestamp for CSV downloads', () => {
        expect(getShareTableFileName('标题', 'csv', timestamp)).toBe('HAPI Table-标题-20260818102756.csv')
    })

    it('sanitizes unsafe title characters before creating a filename', () => {
        expect(sanitizeShareFileNamePart('  report:/ Q3  ')).toBe('report- Q3')
    })
})
