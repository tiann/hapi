import { describe, expect, it } from 'vitest'
import { buildFileMentionSearchQuery } from './file-search-query'

describe('buildFileMentionSearchQuery', () => {
    it('keeps incremental path mentions fuzzy-searchable', () => {
        expect(buildFileMentionSearchQuery('src/rou')).toBe('*src/rou*')
    })

    it('supports Windows separators in incremental path mentions', () => {
        expect(buildFileMentionSearchQuery('src\\rou')).toBe('*src\\rou*')
    })

    it('keeps filename-only mentions unchanged', () => {
        expect(buildFileMentionSearchQuery('git')).toBe('git')
    })

    it('does not wrap an existing wildcard query', () => {
        expect(buildFileMentionSearchQuery('src/*.ts')).toBe('src/*.ts')
    })
})
