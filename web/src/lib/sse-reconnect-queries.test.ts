import { describe, expect, it } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { getSseReconnectQueryKeys } from './sse-reconnect-queries'

describe('getSseReconnectQueryKeys', () => {
    it('refetches sessions, machines, and the hub upgrade offer after reconnect', () => {
        const keys = getSseReconnectQueryKeys()
        expect(keys).toContainEqual(queryKeys.sessions)
        expect(keys).toContainEqual(['session'])
        expect(keys).toContainEqual(queryKeys.machines)
        expect(keys).toContainEqual(queryKeys.upgradeInfo)
    })
})
