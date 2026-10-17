import { afterEach, describe, expect, it } from 'vitest'
import {
    applyHubPeerToolsDisabled,
    isPeerToolsDisabled,
    resetPeerToolsForTests
} from './peerTools'

describe('isPeerToolsDisabled', () => {
    const original = process.env.HAPI_DISABLE_PEER_TOOLS

    afterEach(() => {
        if (original === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = original
        }
        resetPeerToolsForTests()
    })

    it('defaults to enabled (peer tools visible)', () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        expect(isPeerToolsDisabled()).toBe(false)
    })

    it.each(['1', 'true', 'TRUE', 'yes', 'Yes'])('disables peer tools for %s', (value) => {
        process.env.HAPI_DISABLE_PEER_TOOLS = value
        expect(isPeerToolsDisabled()).toBe(true)
    })

    it.each(['0', 'false', 'off', 'no'])('keeps peer tools for explicit off spelling %s', (value) => {
        process.env.HAPI_DISABLE_PEER_TOOLS = value
        expect(isPeerToolsDisabled()).toBe(false)
    })

    it('disables peer tools for unrecognized values (fail-safe for a kill switch)', () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = 'banana'
        expect(isPeerToolsDisabled()).toBe(true)
    })

    it('reads from an explicit env object', () => {
        expect(isPeerToolsDisabled({ HAPI_DISABLE_PEER_TOOLS: '1' } as NodeJS.ProcessEnv)).toBe(true)
        expect(isPeerToolsDisabled({ HAPI_DISABLE_PEER_TOOLS: '0' } as NodeJS.ProcessEnv)).toBe(false)
        expect(isPeerToolsDisabled({} as NodeJS.ProcessEnv)).toBe(false)
    })

    it('applies the hub preference when env is unset or empty', () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        applyHubPeerToolsDisabled(true)
        expect(isPeerToolsDisabled()).toBe(true)
        applyHubPeerToolsDisabled(false)
        expect(isPeerToolsDisabled()).toBe(false)

        process.env.HAPI_DISABLE_PEER_TOOLS = ''
        applyHubPeerToolsDisabled(true)
        expect(isPeerToolsDisabled()).toBe(true)
    })

    it('lets an explicit env value override the hub preference in both directions', () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
        applyHubPeerToolsDisabled(false)
        expect(isPeerToolsDisabled()).toBe(true)

        process.env.HAPI_DISABLE_PEER_TOOLS = '0'
        applyHubPeerToolsDisabled(true)
        expect(isPeerToolsDisabled()).toBe(false)
    })
})
