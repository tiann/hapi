import { describe, expect, it } from 'vitest'
import type { DirectoryEntry } from '@/types/api'
import { sortDirectoryEntries } from './directory-sort'

const entries: DirectoryEntry[] = [
    { name: 'large.txt', type: 'file', size: 500, modified: 20 },
    { name: 'folder-b', type: 'directory', size: 999, modified: 30 },
    { name: 'small.txt', type: 'file', size: 10, modified: 10 },
    { name: 'unknown.txt', type: 'file' },
    { name: 'folder-a', type: 'directory', size: 1, modified: 5 },
]

describe('directory sorting', () => {
    it('defaults to folders first and name ascending', () => {
        expect(sortDirectoryEntries(entries, { field: 'name', direction: 'asc' }, 'en').map((entry) => entry.name)).toEqual([
            'folder-a', 'folder-b', 'large.txt', 'small.txt', 'unknown.txt',
        ])
    })

    it('sorts files by size while keeping folders alphabetic', () => {
        expect(sortDirectoryEntries(entries, { field: 'size', direction: 'desc' }, 'en').map((entry) => entry.name)).toEqual([
            'folder-a', 'folder-b', 'large.txt', 'small.txt', 'unknown.txt',
        ])
    })

    it('sorts by modified time and leaves missing metadata last', () => {
        expect(sortDirectoryEntries(entries, { field: 'modified', direction: 'desc' }, 'en').map((entry) => entry.name)).toEqual([
            'folder-b', 'folder-a', 'large.txt', 'small.txt', 'unknown.txt',
        ])
    })
})
