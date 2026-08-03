import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_CODEX_EXPLORATION_COLLAPSED,
    getInitialCodexExplorationCollapsed,
} from './useCodexExplorationCollapse'

describe('useCodexExplorationCollapse helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to collapsed', () => {
        expect(getInitialCodexExplorationCollapsed()).toBe(DEFAULT_CODEX_EXPLORATION_COLLAPSED)
    })

    it('reads valid stored values and ignores invalid values', () => {
        window.localStorage.setItem('hapi-codex-exploration-collapsed', 'false')
        expect(getInitialCodexExplorationCollapsed()).toBe(false)

        window.localStorage.setItem('hapi-codex-exploration-collapsed', 'invalid')
        expect(getInitialCodexExplorationCollapsed()).toBe(DEFAULT_CODEX_EXPLORATION_COLLAPSED)
    })
})
