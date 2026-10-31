import { describe, expect, it } from 'vitest'
import { groupItemsByStatus } from './BoardList'
import type { BoardItem } from '@/types/api'

function makeItem(overrides: Partial<BoardItem>): BoardItem {
    return {
        id: overrides.id ?? 'id',
        title: overrides.title ?? 'title',
        url: overrides.url ?? null,
        number: overrides.number ?? null,
        repo: overrides.repo ?? null,
        state: overrides.state ?? null,
        status: overrides.status ?? null,
        updatedAt: overrides.updatedAt ?? null,
        body: overrides.body ?? null,
        isPullRequest: overrides.isPullRequest ?? false,
        createdAt: overrides.createdAt ?? null,
        closedAt: overrides.closedAt ?? null,
        author: overrides.author ?? null,
        assignees: overrides.assignees ?? [],
        labels: overrides.labels ?? [],
        milestone: overrides.milestone ?? null,
        customFields: overrides.customFields ?? [],
    }
}

describe('groupItemsByStatus', () => {
    it('orders groups by the board status order, verbatim — no done-value reordering', () => {
        const items = [
            makeItem({ id: 'a', status: 'Done' }),
            makeItem({ id: 'b', status: 'Todo' }),
            makeItem({ id: 'c', status: 'In Progress' }),
            makeItem({ id: 'd', status: 'Todo' }),
        ]
        const groups = groupItemsByStatus(items, ['Todo', 'In Progress', 'Done'])

        expect(groups.map(g => g.status)).toEqual(['Todo', 'In Progress', 'Done'])
        expect(groups[0]!.items.map(i => i.id)).toEqual(['b', 'd'])
        expect(groups[1]!.items.map(i => i.id)).toEqual(['c'])
        expect(groups[2]!.items.map(i => i.id)).toEqual(['a'])
    })

    it('buckets items with no status value into a trailing null-status group', () => {
        const items = [
            makeItem({ id: 'a', status: 'Todo' }),
            makeItem({ id: 'b', status: null }),
        ]
        const groups = groupItemsByStatus(items, ['Todo'])

        expect(groups.map(g => g.status)).toEqual(['Todo', null])
        expect(groups[1]!.items.map(i => i.id)).toEqual(['b'])
    })

    it('keeps a real status column literally named "noStatus" distinct from the missing-status bucket', () => {
        const items = [
            makeItem({ id: 'a', status: 'noStatus' }),
            makeItem({ id: 'b', status: null }),
        ]
        const groups = groupItemsByStatus(items, ['noStatus'])

        expect(groups).toHaveLength(2)
        expect(groups[0]).toMatchObject({ status: 'noStatus', items: [items[0]] })
        expect(groups[1]).toMatchObject({ status: null, items: [items[1]] })
    })

    it('appends statuses not present in statusOrder after the known ones', () => {
        const items = [
            makeItem({ id: 'a', status: 'Backlog' }),
            makeItem({ id: 'b', status: 'Todo' }),
        ]
        const groups = groupItemsByStatus(items, ['Todo'])

        expect(groups.map(g => g.status)).toEqual(['Todo', 'Backlog'])
    })

    it('keeps every status as its own group regardless of how many items share it', () => {
        const items = [
            makeItem({ id: 'a', status: 'Done' }),
            makeItem({ id: 'b', status: 'Archived' }),
            makeItem({ id: 'c', status: 'Todo' }),
        ]
        const groups = groupItemsByStatus(items, ['Todo', 'Done', 'Archived'])

        expect(groups.map(g => g.status)).toEqual(['Todo', 'Done', 'Archived'])
    })
})
