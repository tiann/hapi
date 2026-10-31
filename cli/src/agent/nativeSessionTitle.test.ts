import { describe, expect, it, vi } from 'vitest'
import { createNativeSessionTitleMetadataSync } from './nativeSessionTitle'
import type { Metadata } from '@/api/types'

describe('createNativeSessionTitleMetadataSync', () => {
    it('writes summary without overwriting an intentional metadata.name', () => {
        let metadata: Metadata = {
            path: '/tmp',
            host: 'localhost',
            name: 'issue-triage-#54'
        }
        const client = {
            getMetadata: () => metadata,
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        const sync = createNativeSessionTitleMetadataSync(client)
        sync('Native generated title')

        expect(metadata.name).toBe('issue-triage-#54')
        expect(metadata.summary?.text).toBe('Native generated title')
    })
})
