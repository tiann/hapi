import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { requireHubUrlForLogin } from './runtime-config'

describe('requireHubUrlForLogin', () => {
    const originalEnv = import.meta.env.VITE_REQUIRE_HUB_URL

    afterEach(() => {
        import.meta.env.VITE_REQUIRE_HUB_URL = originalEnv
    })

    it('returns true for "1"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = '1'
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('returns true for "true"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = 'true'
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('returns true for "yes"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = 'yes'
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('returns true for "on"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = 'on'
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('returns true for uppercase "TRUE"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = 'TRUE'
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('returns true for mixed case "Yes"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = 'Yes'
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('returns false for "0"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = '0'
        expect(requireHubUrlForLogin()).toBe(false)
    })

    it('returns false for "false"', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = 'false'
        expect(requireHubUrlForLogin()).toBe(false)
    })

    it('returns false for undefined', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = undefined
        expect(requireHubUrlForLogin()).toBe(false)
    })

    it('returns false for empty string', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = ''
        expect(requireHubUrlForLogin()).toBe(false)
    })

    it('handles whitespace', () => {
        import.meta.env.VITE_REQUIRE_HUB_URL = '  true  '
        expect(requireHubUrlForLogin()).toBe(true)
    })
})
