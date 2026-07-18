import { describe, expect, it } from 'vitest'
import { getGrokHome, getGrokSessionDir, normalizeGrokCwd } from './grokPaths'

describe('grok paths', () => {
    it('respects GROK_HOME and percent-encodes the canonical absolute cwd', () => {
        expect(getGrokHome({ GROK_HOME: '/tmp/custom-grok-home' })).toBe('/tmp/custom-grok-home')
        expect(getGrokSessionDir({
            grokHome: '/tmp/custom-grok-home',
            cwd: '/Users/test/Project A',
            sessionId: 'session-1'
        })).toBe('/tmp/custom-grok-home/sessions/%2FUsers%2Ftest%2FProject%20A/session-1')
    })

    it.skipIf(process.platform !== 'darwin')('uses the realpath spelling used by Grok for macOS /tmp', () => {
        expect(normalizeGrokCwd('/tmp/example')).toBe('/private/tmp/example')
    })
})
