import { afterEach, describe, expect, it } from 'vitest'
import { resolveManagedProviderWireModel } from './providerModel'

const originalProfileId = process.env.HAPI_PROVIDER_PROFILE_ID

afterEach(() => {
    if (originalProfileId === undefined) delete process.env.HAPI_PROVIDER_PROFILE_ID
    else process.env.HAPI_PROVIDER_PROFILE_ID = originalProfileId
})

describe('resolveManagedProviderWireModel', () => {
    it('keeps native model selections intact', () => {
        delete process.env.HAPI_PROVIDER_PROFILE_ID
        expect(resolveManagedProviderWireModel('opus[1m]')).toBe('opus[1m]')
    })

    it('removes HAPI 1M display markers for managed provider requests', () => {
        process.env.HAPI_PROVIDER_PROFILE_ID = 'profile-1'
        expect(resolveManagedProviderWireModel('glm-5.2[1M]')).toBe('glm-5.2')
        expect(resolveManagedProviderWireModel('glm-5.2')).toBe('glm-5.2')
    })
})
