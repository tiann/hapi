import { describe, expect, it } from 'vitest'
import type { BoardItem } from '@/types/api'
import { buildBoardItemSpawnMessage } from './boardItemSpawnMessage'

function makeItem(overrides: Partial<BoardItem>): BoardItem {
    return {
        id: 'id',
        title: 'Fix the thing',
        url: null,
        number: null,
        repo: null,
        state: null,
        status: null,
        updatedAt: null,
        body: null,
        isPullRequest: false,
        createdAt: null,
        closedAt: null,
        author: null,
        assignees: [],
        labels: [],
        milestone: null,
        customFields: [],
        ...overrides
    }
}

describe('buildBoardItemSpawnMessage', () => {
    it('instructs the agent to investigate, including the url/number/repo, for a linked issue', () => {
        expect(buildBoardItemSpawnMessage(makeItem({
            title: 'Fix the thing',
            number: 12,
            url: 'https://github.com/acme/widgets/issues/12',
            repo: 'acme/widgets'
        }))).toBe("You've been spawned from a Boards card — https://github.com/acme/widgets/issues/12 (#12, acme/widgets). Investigate the issue and prepare to discuss/implement with the operator.")
    })

    it('says "pull request" instead of "issue" when the item is a PR', () => {
        expect(buildBoardItemSpawnMessage(makeItem({
            title: 'Add the thing',
            number: 13,
            url: 'https://github.com/acme/widgets/pull/13',
            repo: 'acme/widgets',
            isPullRequest: true
        }))).toBe("You've been spawned from a Boards card — https://github.com/acme/widgets/pull/13 (#13, acme/widgets). Investigate the pull request and prepare to discuss/implement with the operator.")
    })

    it('omits the repo from the parenthetical when unknown', () => {
        expect(buildBoardItemSpawnMessage(makeItem({
            title: 'Fix the thing',
            number: 12,
            url: 'https://github.com/acme/widgets/issues/12'
        }))).toBe("You've been spawned from a Boards card — https://github.com/acme/widgets/issues/12 (#12). Investigate the issue and prepare to discuss/implement with the operator.")
    })

    it('falls back to a context-free message for a draft item with no linked issue/PR', () => {
        expect(buildBoardItemSpawnMessage(makeItem({ title: 'Untracked idea' })))
            .toBe('You\'ve been spawned from a Boards card: "Untracked idea". It has no linked issue or PR — check the board or ask the operator for context.')
    })

    it('never includes the raw issue body — the agent fetches it itself', () => {
        const result = buildBoardItemSpawnMessage(makeItem({
            title: 'Fix the thing',
            number: 12,
            url: 'https://github.com/acme/widgets/issues/12',
            body: 'Some **markdown** body that should not be pasted in.'
        }))
        expect(result).not.toContain('markdown')
        expect(result).not.toContain('should not be pasted')
    })
})
