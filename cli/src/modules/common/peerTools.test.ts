import { afterEach, describe, expect, it } from 'vitest'
import {
    applyHubPeerToolsDisabled,
    isPeerToolsDisabled,
    peerToolsEnvOverlay,
    resetPeerToolsForTests,
    withPeerToolsPreference
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

describe('peerToolsEnvOverlay', () => {
    it('pins the session preference as an explicit env value when the machine env is unset', () => {
        expect(peerToolsEnvOverlay(true, {} as NodeJS.ProcessEnv)).toEqual({ HAPI_DISABLE_PEER_TOOLS: '1' })
        expect(peerToolsEnvOverlay(false, {} as NodeJS.ProcessEnv)).toEqual({ HAPI_DISABLE_PEER_TOOLS: '0' })
    })

    it('treats an empty machine env as unset (session preference still pins)', () => {
        expect(peerToolsEnvOverlay(true, { HAPI_DISABLE_PEER_TOOLS: '' } as NodeJS.ProcessEnv))
            .toEqual({ HAPI_DISABLE_PEER_TOOLS: '1' })
    })

    it('keeps a non-empty machine env authoritative (deploy-time override inherits, no overlay)', () => {
        for (const machineValue of ['1', '0', 'banana']) {
            expect(peerToolsEnvOverlay(true, { HAPI_DISABLE_PEER_TOOLS: machineValue } as NodeJS.ProcessEnv))
                .toEqual({})
            expect(peerToolsEnvOverlay(false, { HAPI_DISABLE_PEER_TOOLS: machineValue } as NodeJS.ProcessEnv))
                .toEqual({})
        }
    })
})

describe('withPeerToolsPreference', () => {
    it('produces an env that resolves to the session preference from a fresh process', () => {
        // A wrapped agent shelling `hapi ping-peer` starts with no module
        // memory; the pinned env alone must carry the resolution.
        expect(isPeerToolsDisabled(withPeerToolsPreference(true, {} as NodeJS.ProcessEnv))).toBe(true)
        expect(isPeerToolsDisabled(withPeerToolsPreference(false, {} as NodeJS.ProcessEnv))).toBe(false)
    })

    it('pins enabled sessions so a later global flip cannot rewrite their children', () => {
        const childEnv = withPeerToolsPreference(false, {} as NodeJS.ProcessEnv)
        applyHubPeerToolsDisabled(true)
        expect(isPeerToolsDisabled(childEnv)).toBe(false)
    })

    it('lets a machine-level override beat the session snapshot (explicit env wins)', () => {
        expect(isPeerToolsDisabled(withPeerToolsPreference(true, { HAPI_DISABLE_PEER_TOOLS: '0' } as NodeJS.ProcessEnv))).toBe(false)
        expect(isPeerToolsDisabled(withPeerToolsPreference(false, { HAPI_DISABLE_PEER_TOOLS: '1' } as NodeJS.ProcessEnv))).toBe(true)
    })

    it('merges the overlay without mutating the source env', () => {
        const source: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
        const merged = withPeerToolsPreference(true, source)
        expect(merged).toEqual({ PATH: '/usr/bin', HAPI_DISABLE_PEER_TOOLS: '1' })
        expect(source).toEqual({ PATH: '/usr/bin' })
    })
})
