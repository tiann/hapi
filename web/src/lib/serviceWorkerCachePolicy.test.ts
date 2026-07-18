import { describe, expect, it, vi } from 'vitest'
import {
    hasLegacyAuthenticatedApiCaches,
    LEGACY_AUTHENTICATED_API_CACHE_NAMES,
    removeLegacyAuthenticatedApiCaches,
} from './serviceWorkerCachePolicy'

describe('service worker authenticated cache policy', () => {
    it('deletes every legacy cache that could contain authenticated business data', async () => {
        const deleteCache = vi.fn(async () => true)

        await removeLegacyAuthenticatedApiCaches({ delete: deleteCache })

        expect(LEGACY_AUTHENTICATED_API_CACHE_NAMES).toEqual([
            'api-sessions',
            'api-session-detail',
            'api-machines',
        ])
        expect(deleteCache.mock.calls).toEqual([
            ['api-sessions'],
            ['api-session-detail'],
            ['api-machines'],
        ])
    })

    it('detects whether an installed worker must force the authenticated-cache migration', async () => {
        await expect(hasLegacyAuthenticatedApiCaches({
            keys: async () => ['local-assets', 'api-session-detail'],
        })).resolves.toBe(true)
        await expect(hasLegacyAuthenticatedApiCaches({
            keys: async () => ['local-assets', 'cdn-socketio'],
        })).resolves.toBe(false)
    })
})
