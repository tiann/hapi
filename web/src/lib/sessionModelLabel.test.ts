import { describe, expect, it } from 'vitest'
import { getSessionModelLabel } from './sessionModelLabel'

describe('getSessionModelLabel', () => {
    it('prefers the actual model name stored in session metadata', () => {
        expect(getSessionModelLabel({
            metadata: {
                path: '/Users/test/project',
                host: 'test-host',
                model: 'gpt-5.4'
            },
            modelMode: 'default'
        })).toBe('gpt-5.4')
    })

    it('falls back to modelMode when no actual model is stored', () => {
        expect(getSessionModelLabel({
            metadata: {
                path: '/Users/test/project',
                host: 'test-host'
            },
            modelMode: 'opus'
        })).toBe('opus')
    })

    it('falls back to default when neither actual model nor model mode is available', () => {
        expect(getSessionModelLabel({
            metadata: {
                path: '/Users/test/project',
                host: 'test-host'
            },
            modelMode: undefined
        })).toBe('default')
    })
})
