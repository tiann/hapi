import { describe, expect, it } from 'vitest'

import {
    applyManualOrder,
    moveGroup,
    moveSession,
    reconcileManualOrder,
    snapshotManualOrder
} from './sessionSortOrder'

type TestSession = {
    id: string
}

type TestGroup = {
    key: string
    sessions: TestSession[]
}

function makeGroups(): TestGroup[] {
    return [
        {
            key: 'group-a',
            sessions: [{ id: 'a1' }, { id: 'a2' }]
        },
        {
            key: 'group-b',
            sessions: [{ id: 'b1' }, { id: 'b2' }]
        }
    ]
}

describe('sessionSortOrder', () => {
    it('captures snapshot for groups and sessions', () => {
        const groups = makeGroups()
        const snapshot = snapshotManualOrder(groups)

        expect(snapshot.groupOrder).toEqual(['group-a', 'group-b'])
        expect(snapshot.sessionOrder['group-a']).toEqual(['a1', 'a2'])
        expect(snapshot.sessionOrder['group-b']).toEqual(['b1', 'b2'])
    })

    it('reconciles stale ids and appends unknown items to bottom', () => {
        const groups: TestGroup[] = [
            {
                key: 'group-b',
                sessions: [{ id: 'b2' }, { id: 'b3' }]
            },
            {
                key: 'group-c',
                sessions: [{ id: 'c1' }]
            }
        ]

        const reconciled = reconcileManualOrder(groups, {
            groupOrder: ['group-a', 'group-b'],
            sessionOrder: {
                'group-b': ['b1', 'b2']
            }
        })

        expect(reconciled.groupOrder).toEqual(['group-b', 'group-c'])
        expect(reconciled.sessionOrder['group-b']).toEqual(['b2', 'b3'])
        expect(reconciled.sessionOrder['group-c']).toEqual(['c1'])
    })

    it('applies manual order to groups and sessions', () => {
        const groups = makeGroups()
        const ordered = applyManualOrder(groups, {
            groupOrder: ['group-b', 'group-a'],
            sessionOrder: {
                'group-a': ['a2', 'a1'],
                'group-b': ['b2', 'b1']
            }
        })

        expect(ordered.map((group) => group.key)).toEqual(['group-b', 'group-a'])
        expect(ordered[0]?.sessions.map((session) => session.id)).toEqual(['b2', 'b1'])
        expect(ordered[1]?.sessions.map((session) => session.id)).toEqual(['a2', 'a1'])
    })

    it('moves groups up and down', () => {
        const base = {
            groupOrder: ['group-a', 'group-b', 'group-c'],
            sessionOrder: {}
        }

        const movedDown = moveGroup(base, 'group-b', 'down')
        expect(movedDown.groupOrder).toEqual(['group-a', 'group-c', 'group-b'])

        const movedUp = moveGroup(base, 'group-b', 'up')
        expect(movedUp.groupOrder).toEqual(['group-b', 'group-a', 'group-c'])

        const boundary = moveGroup(base, 'group-a', 'up')
        expect(boundary).toBe(base)
    })

    it('moves sessions within the same group', () => {
        const base = {
            groupOrder: ['group-a'],
            sessionOrder: {
                'group-a': ['a1', 'a2', 'a3']
            }
        }

        const moved = moveSession(base, 'group-a', 'a2', 'down')
        expect(moved.sessionOrder['group-a']).toEqual(['a1', 'a3', 'a2'])

        const boundary = moveSession(base, 'group-a', 'a1', 'up')
        expect(boundary).toBe(base)
    })
})
