import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from '@tanstack/react-router'
import { createAppRouter, getAppRouterBasepath } from './router'

describe('createAppRouter', () => {
    it('keeps root routes unprefixed by default', () => {
        const router = createAppRouter(createMemoryHistory({ initialEntries: ['/sessions'] }))

        expect(router.options.basepath).toBe('/')
    })

    it('uses /new as the browser basepath for preview builds', () => {
        const router = createAppRouter(createMemoryHistory({ initialEntries: ['/new/sessions'] }), {
            basepath: '/new',
        })

        expect(router.options.basepath).toBe('/new')
        expect(getAppRouterBasepath('/new/')).toBe('/new')
    })
})
