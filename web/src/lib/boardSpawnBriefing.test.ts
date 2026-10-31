import { afterEach, describe, expect, it } from 'vitest'
import { clearBoardSpawnBriefing, peekBoardSpawnBriefing, stashBoardSpawnBriefing } from './boardSpawnBriefing'

afterEach(() => {
    sessionStorage.clear()
})

describe('boardSpawnBriefing', () => {
    it('round-trips a stashed briefing by its opaque id', () => {
        const id = stashBoardSpawnBriefing({ message: 'Fix the thing', linkIssueUrl: 'https://github.com/heavygee/hapi/issues/235', title: 'Fix the thing' })
        expect(peekBoardSpawnBriefing(id)).toEqual({ message: 'Fix the thing', linkIssueUrl: 'https://github.com/heavygee/hapi/issues/235', title: 'Fix the thing' })
    })

    it('does not delete on peek — the same id can be read again (survives a /browse round trip)', () => {
        const id = stashBoardSpawnBriefing({ message: 'Fix the thing', title: 'Fix the thing' })
        peekBoardSpawnBriefing(id)
        expect(peekBoardSpawnBriefing(id)).toEqual({ message: 'Fix the thing', title: 'Fix the thing', linkIssueUrl: undefined })
    })

    it('clears the entry so it is no longer readable afterward', () => {
        const id = stashBoardSpawnBriefing({ message: 'Fix the thing', title: 'Fix the thing' })
        clearBoardSpawnBriefing(id)
        expect(peekBoardSpawnBriefing(id)).toBeNull()
    })

    it('returns null for an unknown id', () => {
        expect(peekBoardSpawnBriefing('not-a-real-id')).toBeNull()
    })

    it('still delivers the message/issue-link for a stash missing a title (stale pre-rename-fix entry) — only the rename is skipped', () => {
        const id = 'stale-id'
        sessionStorage.setItem('hapi:board-spawn-briefing:' + id, JSON.stringify({ message: 'Fix the thing', linkIssueUrl: 'https://github.com/heavygee/hapi/issues/235' }))
        expect(peekBoardSpawnBriefing(id)).toEqual({ message: 'Fix the thing', linkIssueUrl: 'https://github.com/heavygee/hapi/issues/235', title: undefined })
    })
})
