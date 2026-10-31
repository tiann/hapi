import { describe, expect, it } from 'vitest'
import { beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { sortSessionGroupsBySessionCount, useSessionProjectOrder } from './useSessionProjectOrder'

beforeEach(() => {
    window.localStorage.clear()
})

describe('useSessionProjectOrder', () => {
    it('persists first-seen project order and appends newly discovered projects', () => {
        const hook = renderHook(({ keys }: { keys: string[] }) => useSessionProjectOrder(keys), {
            initialProps: { keys: ['mine', 'hapi'] },
        })

        expect(hook.result.current).toEqual(['mine', 'hapi'])
        expect(JSON.parse(window.localStorage.getItem('hapi-session-project-order')!)).toEqual(['mine', 'hapi'])

        hook.rerender({ keys: ['hapi', 'mine', 'new'] })
        expect(hook.result.current).toEqual(['mine', 'hapi', 'new'])
        expect(JSON.parse(window.localStorage.getItem('hapi-session-project-order')!)).toEqual(['mine', 'hapi', 'new'])
    })
})

describe('sortSessionGroupsBySessionCount', () => {
    it('puts projects with the most sessions first and uses first-seen order for ties', () => {
        const groups = [
            { key: 'hapi', sessions: [{ id: 'hapi-1' }] },
            { key: 'new', sessions: [{ id: 'new-1' }, { id: 'new-2' }] },
            { key: 'mine', sessions: [{ id: 'mine-1' }, { id: 'mine-2' }] },
        ]

        expect(sortSessionGroupsBySessionCount(groups, ['mine', 'hapi', 'new']).map((group) => group.key)).toEqual([
            'mine',
            'new',
            'hapi',
        ])
    })

    it('uses total project counts when a group only contains one session state', () => {
        const groups = [
            { key: 'hapi', sessions: [{ id: 'hapi-active' }] },
            { key: 'mine', sessions: [{ id: 'mine-active' }] },
        ]

        expect(sortSessionGroupsBySessionCount(groups, ['hapi', 'mine'], new Map([
            ['hapi', 1],
            ['mine', 2],
        ])).map((group) => group.key)).toEqual(['mine', 'hapi'])
    })
})
