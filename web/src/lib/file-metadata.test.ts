import { describe, expect, it, vi } from 'vitest'
import { formatFileMetadata, formatFileSize, formatModifiedTime } from './file-metadata'

describe('file metadata formatting', () => {
    it('formats byte sizes using compact binary units', () => {
        expect(formatFileSize(0)).toBe('0 B')
        expect(formatFileSize(999)).toBe('999 B')
        expect(formatFileSize(1536)).toBe('1.5 KB')
        expect(formatFileSize(12 * 1024)).toBe('12 KB')
        expect(formatFileSize(2.25 * 1024 * 1024)).toBe('2.3 MB')
    })

    it('ignores invalid metadata', () => {
        expect(formatFileSize(undefined)).toBeNull()
        expect(formatFileSize(-1)).toBeNull()
        expect(formatModifiedTime(Number.NaN, 'en')).toBeNull()
    })

    it('combines available size and modified time', () => {
        vi.stubGlobal('Intl', {
            ...Intl,
            DateTimeFormat: class {
                format() { return '2026/07/16 10:31' }
            },
        })
        expect(formatFileMetadata(1024, 1_784_175_060_000, 'en')).toBe('2026/07/16 10:31 · 1 KB')
        vi.unstubAllGlobals()
    })
})
