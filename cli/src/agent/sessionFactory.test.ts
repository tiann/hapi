import { afterEach, describe, expect, it } from 'vitest'
import { buildSessionMetadata } from './sessionFactory'

describe('buildSessionMetadata', () => {
    const originalHostname = process.env.HAPI_HOSTNAME

    afterEach(() => {
        if (originalHostname === undefined) {
            delete process.env.HAPI_HOSTNAME
        } else {
            process.env.HAPI_HOSTNAME = originalHostname
        }
    })

    it('uses HAPI_HOSTNAME for session metadata host when provided', () => {
        process.env.HAPI_HOSTNAME = 'custom-session-host'

        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            now: 123
        })

        expect(metadata.host).toBe('custom-session-host')
    })
})
