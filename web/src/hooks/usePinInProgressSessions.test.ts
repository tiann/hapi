import { afterEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_PIN_IN_PROGRESS_MODE,
    PIN_IN_PROGRESS_STORAGE_KEY,
    getInitialPinInProgressMode,
    parsePinInProgressMode
} from './usePinInProgressSessions'

describe('parsePinInProgressMode', () => {
    it('defaults unset to jobs (capability stand)', () => {
        expect(parsePinInProgressMode(null)).toBe('jobs')
        expect(parsePinInProgressMode('')).toBe('jobs')
        expect(DEFAULT_PIN_IN_PROGRESS_MODE).toBe('jobs')
    })

    it('migrates legacy boolean strings', () => {
        expect(parsePinInProgressMode('true')).toBe('all')
        expect(parsePinInProgressMode('false')).toBe('off')
    })

    it('accepts explicit tri-state values', () => {
        expect(parsePinInProgressMode('off')).toBe('off')
        expect(parsePinInProgressMode('jobs')).toBe('jobs')
        expect(parsePinInProgressMode('all')).toBe('all')
    })

    it('falls back to jobs on garbage', () => {
        expect(parsePinInProgressMode('maybe')).toBe('jobs')
    })
})

describe('getInitialPinInProgressMode', () => {
    afterEach(() => {
        localStorage.removeItem(PIN_IN_PROGRESS_STORAGE_KEY)
    })

    it('persists jobs default so later Off is distinct from unset', () => {
        localStorage.removeItem(PIN_IN_PROGRESS_STORAGE_KEY)
        expect(getInitialPinInProgressMode()).toBe('jobs')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('jobs')
    })

    it('rewrites legacy false to persisted off', () => {
        localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, 'false')
        expect(getInitialPinInProgressMode()).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
    })
})
