import { describe, expect, it } from 'vitest'
import type { DirectoryEntry, FileSearchItem } from '@/types/api'
import { sortDirectoryEntries, sortFileSearchItems } from './directory-sort'

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

describe('file search sorting', () => {
    const results: FileSearchItem[] = [
        { fileName: 'large10.txt', filePath: 'src', fullPath: 'src/large10.txt', fileType: 'file', size: 500, modified: 20 },
        { fileName: 'small2.txt', filePath: 'src', fullPath: 'src/small2.txt', fileType: 'file', size: 10, modified: 10 },
        { fileName: 'unknown.txt', filePath: 'src', fullPath: 'src/unknown.txt', fileType: 'file' },
    ]

    it('uses natural filename ordering', () => {
        expect(sortFileSearchItems(results, { field: 'name', direction: 'asc' }, 'en').map((entry) => entry.fileName)).toEqual([
            'large10.txt', 'small2.txt', 'unknown.txt',
        ])
    })

    it('sorts metadata and keeps missing values last', () => {
        expect(sortFileSearchItems(results, { field: 'size', direction: 'asc' }, 'en').map((entry) => entry.fileName)).toEqual([
            'small2.txt', 'large10.txt', 'unknown.txt',
        ])
        expect(sortFileSearchItems(results, { field: 'modified', direction: 'desc' }, 'en').map((entry) => entry.fileName)).toEqual([
            'large10.txt', 'small2.txt', 'unknown.txt',
        ])
    })
})
