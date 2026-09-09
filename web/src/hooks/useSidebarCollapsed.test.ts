import { beforeEach, describe, expect, it } from 'vitest'
import { getInitialSidebarCollapsed } from './useSidebarCollapsed'

describe('useSidebarCollapsed helpers', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('defaults to expanded', () => {
        expect(getInitialSidebarCollapsed()).toBe(false)
    })

    it('reads the client-local collapsed state', () => {
        localStorage.setItem('hapi-sidebar-collapsed-v1', 'true')
        expect(getInitialSidebarCollapsed()).toBe(true)
    })
})
