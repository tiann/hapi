import { describe, expect, it } from 'bun:test'
import { isWildcardSearch, matchesSearchQuery, toSearchGlob } from './search'

describe('search wildcard helpers', () => {
    it('only enables wildcard mode for star and question mark patterns', () => {
        expect(isWildcardSearch('feature-*')).toBe(true)
        expect(isWildcardSearch('file-??')).toBe(true)
        expect(isWildcardSearch('feature-[ab]')).toBe(false)
        expect(isWildcardSearch('feature')).toBe(false)
    })

    it('keeps plain text matching as a case-insensitive substring search', () => {
        expect(matchesSearchQuery('Fix Bot Review', 'bot review')).toBe(true)
        expect(matchesSearchQuery('Fix Bot Review', 'BOT')).toBe(true)
        expect(matchesSearchQuery('Fix Bot Review', 'reviewed')).toBe(false)
    })

    it('matches complete wildcard patterns with star and question mark', () => {
        expect(matchesSearchQuery('feature-sidebar-search', 'feature-*')).toBe(true)
        expect(matchesSearchQuery('feature-sidebar-search', 'feature-????')).toBe(false)
        expect(matchesSearchQuery('file-01.ts', 'file-??.ts')).toBe(true)
        expect(matchesSearchQuery('file-001.ts', 'file-??.ts')).toBe(false)
        expect(matchesSearchQuery('src/file.ts', '*.ts')).toBe(true)
        expect(matchesSearchQuery('src/file.ts.bak', '*.ts')).toBe(false)
    })

    it('treats non-wildcard characters as literals', () => {
        expect(matchesSearchQuery('file1.ts', 'file?.ts')).toBe(true)
        expect(matchesSearchQuery('file+.ts', 'file+.ts')).toBe(true)
        expect(matchesSearchQuery('fileX.ts', 'file+.ts')).toBe(false)
    })

    it('handles adversarial wildcard patterns without regex backtracking', () => {
        expect(matchesSearchQuery('a'.repeat(100), '*a*a*a*a*a*a*b')).toBe(false)
    })

    it('keeps ripgrep prefilters literal outside the supported wildcard operators', () => {
        expect(toSearchGlob('  .ts  ')).toBe('*.ts*')
        expect(toSearchGlob('*.ts')).toBe('*.ts')
        expect(toSearchGlob('!*.ts')).toBe('\\!*.ts')
        expect(toSearchGlob('[ab]*.ts')).toBe('\\[ab\\]*.ts')
        expect(toSearchGlob('{a,b}*.ts')).toBe('\\{a,b\\}*.ts')
    })

})
