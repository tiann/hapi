import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_LIST_STATUS_MODE,
    getInitialSessionListStatusMode,
    getSessionListStatusModeOptions,
} from './useSessionListStatusMode'

describe('useSessionListStatusMode helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns the allowed session list status mode options', () => {
        expect(getSessionListStatusModeOptions()).toEqual([
            { value: 'standard', labelKey: 'settings.display.sessionListStatus.standard' },
            { value: 'detailed', labelKey: 'settings.display.sessionListStatus.detailed' },
        ])
    })

    it('falls back to the default mode for missing or invalid storage values', () => {
        expect(getInitialSessionListStatusMode()).toBe(DEFAULT_SESSION_LIST_STATUS_MODE)

        window.localStorage.setItem('hapi-session-list-status-mode', 'invalid')
        expect(getInitialSessionListStatusMode()).toBe(DEFAULT_SESSION_LIST_STATUS_MODE)
    })

    it('reads a valid stored session list status mode', () => {
        window.localStorage.setItem('hapi-session-list-status-mode', 'detailed')

        expect(getInitialSessionListStatusMode()).toBe('detailed')
    })
})
