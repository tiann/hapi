import { describe, expect, it } from 'bun:test'
import {
    appendClaudeSessionIdHistory,
    CLAUDE_SESSION_ID_HISTORY_LIMIT,
    matchesClaudeSessionId,
    mergeClaudeSessionIdHistory
} from './claudeSessionIdHistory'

describe('claudeSessionIdHistory', () => {
    it('appends the previous id once and never keeps the current id', () => {
        expect(appendClaudeSessionIdHistory(undefined, undefined, 'a')).toEqual([])
        expect(appendClaudeSessionIdHistory([], 'a', 'b')).toEqual(['a'])
        expect(appendClaudeSessionIdHistory(['a'], 'b', 'b')).toEqual(['a'])
        expect(appendClaudeSessionIdHistory(['a', 'b'], 'c', 'a')).toEqual(['b', 'c'])
    })

    it('keeps only the most recent ids', () => {
        const long = Array.from({ length: CLAUDE_SESSION_ID_HISTORY_LIMIT + 5 }, (_, i) => `id-${i}`)
        const result = appendClaudeSessionIdHistory(long, 'latest', 'current')
        expect(result).toHaveLength(CLAUDE_SESSION_ID_HISTORY_LIMIT)
        expect(result.at(-1)).toBe('latest')
    })

    it('merges source ids into the target and is idempotent', () => {
        const source = { claudeSessionId: 'src', claudeSessionIdHistory: ['src-old'] }
        const target: Record<string, unknown> = { claudeSessionId: 'dst', claudeSessionIdHistory: ['dst-old'] }

        const merged = mergeClaudeSessionIdHistory(source, target)
        expect(merged).toEqual(['src-old', 'src', 'dst-old'])

        target.claudeSessionIdHistory = merged
        expect(mergeClaudeSessionIdHistory(source, target)).toBeNull()
    })

    it('returns null when there is nothing to record', () => {
        expect(mergeClaudeSessionIdHistory({ claudeSessionId: 'same' }, { claudeSessionId: 'same' })).toBeNull()
        expect(mergeClaudeSessionIdHistory({}, {})).toBeNull()
    })

    it('matches current and historical ids', () => {
        const metadata = { claudeSessionId: 'now', claudeSessionIdHistory: ['before'] }
        expect(matchesClaudeSessionId(metadata, 'now')).toBe('current')
        expect(matchesClaudeSessionId(metadata, 'before')).toBe('historical')
        expect(matchesClaudeSessionId(metadata, 'other')).toBeNull()
        expect(matchesClaudeSessionId(null, 'now')).toBeNull()
    })
})
