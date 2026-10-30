import { afterEach, describe, expect, it } from 'vitest'
import { isPeerToolsDisabled } from './peerTools'

describe('isPeerToolsDisabled', () => {
    const original = process.env.HAPI_DISABLE_PEER_TOOLS

    afterEach(() => {
        if (original === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = original
        }
    })

    it('defaults to enabled (peer tools visible)', () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        expect(isPeerToolsDisabled()).toBe(false)
    })

    it.each(['1', 'true', 'TRUE', 'yes', 'Yes'])('disables peer tools for %s', (value) => {
        process.env.HAPI_DISABLE_PEER_TOOLS = value
        expect(isPeerToolsDisabled()).toBe(true)
    })

    it('stays enabled for unrelated values', () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '0'
        expect(isPeerToolsDisabled()).toBe(false)
    })

    it('reads from an explicit env object', () => {
        expect(isPeerToolsDisabled({ HAPI_DISABLE_PEER_TOOLS: '1' } as NodeJS.ProcessEnv)).toBe(true)
        expect(isPeerToolsDisabled({} as NodeJS.ProcessEnv)).toBe(false)
    })
})
